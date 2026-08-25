/**
 * Hand-run:  node src/test/testPurgeMigration.js
 *
 * 002 removes other people's data. Every other migration here moves rows; this
 * one is the only one that takes them away, so the properties worth asserting
 * are the ones that make a mistake recoverable rather than final.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const tests = [];
const test = (n, f) => tests.push([n, f]);
const src = readFileSync("src/tools/mongo/migrations/002-purge-and-renumber.js", "utf8");

test("nothing is hard deleted — rows are archived first", () => {
    const archive = src.indexOf("insertMany");
    const remove = src.indexOf("deleteMany");
    assert.ok(archive > 0 && remove > 0, "both an archive write and a delete must exist");
    assert.ok(archive < remove,
        "deleting before archiving loses the rows if the insert then fails");
});

test("the archive records where each row came from", () => {
    for (const field of ["migration", "sourceCollection", "ownerId", "archivedAt"]) {
        assert.match(src, new RegExp(`${field}:`), `archive rows need ${field} to be restorable`);
    }
});

test("the owners to purge are a literal list, not a query", () => {
    assert.match(src, /const PURGE_OWNERS = \[[\d, ]+\]/,
        "discovering owners would sweep up anyone who messages between writing this and deploying it");
});

test("it refuses to delete the account it is keeping", async () => {
    const { runPurgeAndRenumber } = await import("../tools/mongo/migrations/002-purge-and-renumber.js");
    assert.strictEqual(typeof runPurgeAndRenumber, "function");
    assert.match(src, /PURGE_OWNERS\.includes\(ownerId\)/,
        "a list containing the owner is the one mistake the archive cannot undo");
    assert.match(src, /refusing to run/);
});

test("the owner's current id is read from their identity, never assumed", () => {
    assert.match(src, /externalId: String\(LEGACY_TELEGRAM_ID\)/);
    assert.match(src, /const ownerId = ownerIdentity\.userId/,
        "001 allocated whatever id was free — hardcoding the result would break on a re-run");
});

test("it blocks rather than purges when 001 has not run", () => {
    assert.match(src, /status = "blocked"/);
    assert.match(src, /refusing to purge/,
        "without the identity row there is no way to tell the owner apart from anyone else");
});

test("the renumber stops if the target id is still held", () => {
    assert.match(src, /is still held after the purge/,
        "moving onto an occupied id violates the unique index and half-migrates the owner");
});

test("collections added since 001 are covered", () => {
    for (const c of ["USER_FACT", "USER_IDENTITY"]) {
        assert.match(src, new RegExp(c),
            `${c} is keyed by userId and did not exist when 001 was written`);
    }
});

test("002 is registered to run after 001", async () => {
    const runner = readFileSync("src/tools/mongo/migrations/runStartupMigrations.js", "utf8");
    const first = runner.indexOf("001-internal-user-ids");
    const second = runner.indexOf("002-purge-and-renumber");
    assert.ok(first > 0 && second > 0, "both migrations must be registered");
    assert.ok(first < second, "002 reads the identity row 001 writes");
});

test("a blocked run is not recorded as done", async () => {
    const runner = readFileSync("src/tools/mongo/migrations/runStartupMigrations.js", "utf8");
    assert.match(runner, /previous\?\.status === "applied" \|\| previous\?\.status === "nothing-to-do"/,
        "only terminal statuses may skip; blocked and failed must retry next boot");
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
