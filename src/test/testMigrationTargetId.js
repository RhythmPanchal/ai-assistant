/**
 * Hand-run:  node src/test/testMigrationTargetId.js
 *
 * The first real run of 001 failed here. The target id was hardcoded to 1, but
 * the bot had been live on the identity layer for hours and a second Telegram
 * account had already been allocated that id. The legacy user is not entitled
 * to id 1 — only to one nobody else holds.
 *
 * Source assertions rather than execution: picking an id needs a live database,
 * and the invariants worth protecting are visible in the code.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const tests = [];
const test = (n, f) => tests.push([n, f]);
const src = readFileSync("src/tools/mongo/migrations/001-internal-user-ids.js", "utf8");

test("no hardcoded target id survives", () => {
    assert.doesNotMatch(src, /TARGET_USER_ID/,
        "a fixed target collides with whoever the identity layer allocated first");
    assert.match(src, /pickFreeUserId/);
});

test("the chosen id starts past the counter and skips anything taken", () => {
    assert.match(src, /while \(taken\.has\(candidate\)\) candidate\+\+/,
        "the counter alone is not enough — a users row can exist without the counter knowing");
    assert.match(src, /counter\?\.seq/,
        "starting below the counter would hand out an id it is about to reissue");
});

test("an existing legacy identity still wins over allocating a new id", () => {
    assert.match(src, /existingIdentity\?\.userId \?\? await pickFreeUserId\(db\)/,
        "the repair path must adopt the id the bot minted, not mint a second one");
});

test("raw Telegram ids never become the counter high-water mark", () => {
    assert.match(src, /INTERNAL_ID_CEILING/);
    // Two places must filter: choosing the target, and seeding the counter after.
    const uses = src.match(/INTERNAL_ID_CEILING/g) ?? [];
    assert.ok(uses.length >= 2,
        "both the ceiling constant and the counter seed must apply it");
    assert.match(src, /n < INTERNAL_ID_CEILING/,
        "an unmigrated user sitting under a ten-digit id would push seq into the billions");
});

test("the ceiling is above any plausible internal id and below any Telegram id", () => {
    const m = src.match(/INTERNAL_ID_CEILING = ([\d_]+)/);
    assert.ok(m, "the ceiling must be a literal, not derived");
    const ceiling = Number(m[1].replace(/_/g, ""));
    assert.ok(ceiling > 100_000, "too low and a real deployment eventually crosses it");
    assert.ok(ceiling < 100_000_000, "too high and it stops excluding Telegram ids");
    assert.ok(1136575387 > ceiling, "the legacy Telegram id must fall outside it");
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
