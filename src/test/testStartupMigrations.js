/**
 * Hand-run:  node src/test/testStartupMigrations.js
 *
 * Migrations run on boot because the deployed database is not reachable from a
 * laptop. That makes boot ORDER load-bearing in a way nothing else asserts: run
 * too late and the identity layer has already minted a fresh id for the legacy
 * user, stranding every existing row under the old one — silently, and only for
 * the one user whose data matters most.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const tests = [];
const test = (n, f) => tests.push([n, f]);
const indexSrc = readFileSync("src/index.js", "utf8");

test("migrations run before the Telegram loop starts", () => {
    const migrate = indexSrc.indexOf("runStartupMigrations()");
    const poll = indexSrc.indexOf("startTelegramPolling(");
    assert.ok(migrate > 0, "runStartupMigrations must be called from initService");
    assert.ok(poll > 0);
    assert.ok(migrate < poll,
        "a message arriving first allocates a new userId and strands the legacy rows");
});

test("migrations run after the indexes they depend on", () => {
    const indexes = indexSrc.indexOf("ensureIndexes()");
    const migrate = indexSrc.indexOf("runStartupMigrations()");
    assert.ok(indexes > 0 && indexes < migrate,
        "the repointing writes rely on the unique indexes already existing");
});

test("migrations run before cron can fire a routine", () => {
    const migrate = indexSrc.indexOf("runStartupMigrations()");
    const cron = indexSrc.indexOf("initCron()");
    assert.ok(cron > 0 && migrate < cron,
        "a routine firing mid-migration reads half-repointed data");
});

test("the health route reports migration status", () => {
    assert.match(indexSrc, /migrations: migrationStatus/,
        "with no shell access to the host this is the only way to see what a boot migration did");
    assert.match(indexSrc, /RENDER_GIT_COMMIT/,
        "without the deployed commit a push cannot be confirmed live");
});

test("the remote-write endpoint is gone", () => {
    assert.doesNotMatch(indexSrc, /adminRouter/,
        "an endpoint that rewrites every row is not worth keeping once boot does the job");
    let present = false;
    try { readFileSync("src/adminRestAPI.js"); present = true; } catch { /* expected */ }
    assert.strictEqual(present, false, "src/adminRestAPI.js should have been deleted");
});

test("the identity migration is registered to run", async () => {
    const src = readFileSync("src/tools/mongo/migrations/runStartupMigrations.js", "utf8");
    assert.match(src, /001-internal-user-ids/);
    assert.match(src, /apply: true/, "a boot migration that only dry-runs never migrates anything");
});

test("a failed migration does not stop the bot booting", async () => {
    const src = readFileSync("src/tools/mongo/migrations/runStartupMigrations.js", "utf8");
    assert.match(src, /catch \(err\)/);
    assert.match(src, /status: "failed"/,
        "a failure must be visible on the health route, not swallowed");
    // The ledger is only written on success, so a failure retries next boot.
    const ledgerWrite = src.indexOf("ledger.updateOne");
    const catchBlock = src.indexOf("status: \"failed\"");
    assert.ok(ledgerWrite < catchBlock, "the ledger must not record a failed run as done");
});

test("an applied migration is not re-run on every boot", async () => {
    const { MIGRATION_LEDGER, migrationStatus } = await import("../tools/mongo/migrations/runStartupMigrations.js");
    assert.strictEqual(MIGRATION_LEDGER, "migrations");
    assert.deepStrictEqual(migrationStatus, {}, "status starts empty and is filled at boot");

    const src = readFileSync("src/tools/mongo/migrations/runStartupMigrations.js", "utf8");
    assert.match(src, /already \$\{previous\.status\}, skipping/,
        "re-scanning ten collections every restart to learn there is nothing to do is wasted work");
});

let pass = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
        pass++;
    } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
