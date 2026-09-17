/**
 * Hand-run:  node src/test/testOnboardedBackfill.js
 *
 * 006 decides, once and at boot against production, who counts as already
 * onboarded. Getting it wrong either way is silent: stamp a brand-new account
 * and it never sees the real onboarding; miss an established one and /start
 * greets them as a stranger and they can never turn a paused routine back on.
 * So it is run for real, against a scratch database.
 *
 * Uses its own throwaway database — it DROPS it at the start and the end, so it
 * must never share one with the other guards.
 */
import "dotenv/config";

const SCRATCH_DB = "Rasmalai-test-006";
process.env.MONGODB_DB_NAME = SCRATCH_DB;

import assert from "node:assert";
import { readFileSync } from "node:fs";

const { runOnboardedBackfill } = await import("../tools/mongo/migrations/006-onboarded-existing-users.js");
const { getDB } = await import("../tools/mongo/mongoClient.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);

const created = new Date("2026-08-01T00:00:00Z");
const note = (text) => ({ text, previousText: null, updatedAt: created });
let db;

test("a real run marks exactly the established accounts", async () => {
    db = await getDB();
    assert.strictEqual(db.databaseName, SCRATCH_DB, "refusing to seed anything but the scratch database");
    await db.dropDatabase();

    await db.collection("users").insertMany([
        // Routines on: established.
        { userId: 1, name: "Routines on", preferences: { triggersOptIn: true }, onboardedAt: null, createdAt: created, updatedAt: created },
        // Notes only: established.
        { userId: 2, name: "Has notes", preferences: { triggersOptIn: false }, notes: { about: note("Backend developer.") }, createdAt: created, updatedAt: created },
        // Said hello once: gets the real onboarding.
        { userId: 3, name: "Brand new", preferences: { triggersOptIn: false }, onboardedAt: null, createdAt: created, updatedAt: created },
        // Only a cleared note: nothing is known, so not established.
        { userId: 4, name: "Cleared", preferences: { triggersOptIn: false }, notes: { habits: { text: null, previousText: "Gym.", updatedAt: created } }, createdAt: created, updatedAt: created },
        // Already onboarded: left exactly as it is.
        { userId: 5, name: "Done", preferences: { triggersOptIn: true }, onboardedAt: new Date("2026-09-01T00:00:00Z"), createdAt: created, updatedAt: created },
    ]);

    const dry = await runOnboardedBackfill();
    assert.strictEqual(dry.status, "dry-run");
    assert.deepStrictEqual(dry.userIds.sort(), [1, 2]);
    assert.strictEqual(await db.collection("users").countDocuments({ onboardedAt: { $type: "date" } }), 1,
        "a dry run must write nothing");

    const applied = await runOnboardedBackfill({ apply: true });
    assert.strictEqual(applied.status, "applied");
    assert.strictEqual(applied.stamped, 2);

    const byId = Object.fromEntries((await db.collection("users").find().toArray()).map(u => [u.userId, u]));
    assert.deepStrictEqual(byId[1].onboardedAt, created, "stamped with their own createdAt, not the migration's clock");
    assert.deepStrictEqual(byId[2].onboardedAt, created);
    assert.strictEqual(byId[3].onboardedAt, null, "an account that only said hello must still get onboarding");
    assert.ok(!byId[4].onboardedAt, "a cleared note is not something known about them");
    assert.deepStrictEqual(byId[5].onboardedAt, new Date("2026-09-01T00:00:00Z"), "an existing stamp is never moved");
});

test("a second run has nothing to do", async () => {
    const again = await runOnboardedBackfill({ apply: true });
    assert.strictEqual(again.status, "nothing-to-do");
});

test("the report holds ids and counts, never profile content", async () => {
    await db.collection("users").insertOne({
        userId: 6, name: "SECRET-NAME", notes: { about: note("SECRET-ABOUT") }, createdAt: created, updatedAt: created,
    });
    const report = await runOnboardedBackfill({ apply: true });
    assert.doesNotMatch(JSON.stringify(report), /SECRET-/, "GET / serves this report publicly");
});

test("006 runs at boot, after 005", () => {
    const src = readFileSync("src/tools/mongo/migrations/runStartupMigrations.js", "utf8");
    const five = src.indexOf('"005-facts-into-notes"');
    const six = src.indexOf('"006-onboarded-existing-users"');
    assert.ok(five > 0 && six > five, "notes copied from facts must count toward already using it");
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

try {
    const database = await getDB();
    assert.strictEqual(database.databaseName, SCRATCH_DB, "refusing to drop anything but the scratch database");
    await database.dropDatabase();
} catch (e) {
    console.log(`\ncould not drop ${SCRATCH_DB}: ${e.message}`);
}

console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
