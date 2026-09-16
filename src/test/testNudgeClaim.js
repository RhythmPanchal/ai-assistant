/**
 * Hand-run:  node src/test/testNudgeClaim.js
 *
 * "Every day nudging is very bad." claimNudge is the only thing that makes that
 * true: the routines run twice a day, and the model is not trusted to count. So
 * the window is asserted against real writes — including two claims racing,
 * which is the case a read-then-write version would get wrong.
 *
 * Runs against its own throwaway database on the same cluster, dropped at the
 * end. NOT Rasmalai-eval: other guards and the night eval keep state there, and
 * this file drops its database when it finishes.
 */
import "dotenv/config";

const SCRATCH_DB = "Rasmalai-test-nudge";
process.env.MONGODB_DB_NAME = SCRATCH_DB;

import assert from "node:assert";

const { claimNudge } = await import("../tools/mongo/operation/userNotes.js");
const { getDB } = await import("../tools/mongo/mongoClient.js");
const { NUDGE_COOLDOWN_DAYS, NUDGEABLE_SECTIONS } = await import("../tools/mongo/schema/usersSchema.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-20T09:00:00+05:30");
const note = (text) => ({ text, previousText: null, updatedAt: T0 });

let db;
async function seed(userId, notes) {
    await db.collection("users").insertOne({ userId, name: `u${userId}`, createdAt: T0, updatedAt: T0, ...(notes ? { notes } : {}) });
}

test("the scratch database is the one being written", async () => {
    db = await getDB();
    assert.strictEqual(db.databaseName, SCRATCH_DB);
    assert.doesNotMatch(db.databaseName, /prod/i);
    await db.dropDatabase();
});

test("a goal in the notes can be raised the first time", async () => {
    await seed(1, { longTermGoals: note("Remote job abroad.") });
    assert.strictEqual(await claimNudge(1, T0), true);
    const row = await db.collection("users").findOne({ userId: 1 });
    assert.deepStrictEqual(row.notes.lastNudgedAt, T0, "the window is spent when the chance is given");
});

test("not again the same day, nor the next", async () => {
    assert.strictEqual(await claimNudge(1, new Date(T0.getTime() + 60 * 1000)), false, "a second routine the same morning");
    assert.strictEqual(await claimNudge(1, new Date(T0.getTime() + 14 * 60 * 60 * 1000)), false, "the night routine the same day");
    assert.strictEqual(await claimNudge(1, new Date(T0.getTime() + DAY)), false, "tomorrow");
});

test("not until the cooldown has fully passed", async () => {
    const almost = new Date(T0.getTime() + NUDGE_COOLDOWN_DAYS * DAY - 60 * 1000);
    assert.strictEqual(await claimNudge(1, almost), false);
    const due = new Date(T0.getTime() + NUDGE_COOLDOWN_DAYS * DAY);
    assert.strictEqual(await claimNudge(1, due), true);
});

test("a cooldown of a week means about four nudges a month, never daily", () => {
    assert.ok(NUDGE_COOLDOWN_DAYS >= 7, `${NUDGE_COOLDOWN_DAYS} days is more often than the user asked for`);
});

test("two claims racing produce exactly one nudge", async () => {
    await seed(2, { habits: note("Rasmalai most weeknights.") });
    const results = await Promise.all(Array.from({ length: 8 }, () => claimNudge(2, T0)));
    assert.strictEqual(results.filter(Boolean).length, 1,
        "both routines can be open at 09:00; a read-then-write claim would let both through");
});

test("nothing is claimed when there is nothing to raise", async () => {
    await seed(3, { about: note("Backend developer."), routine: note("Up at ten."), behaviour: note("Likes it short.") });
    assert.strictEqual(await claimNudge(3, T0), false,
        "about, routine and behaviour describe someone; there is nothing in them to fall behind on");
    const row = await db.collection("users").findOne({ userId: 3 });
    assert.strictEqual(row.notes.lastNudgedAt, undefined, "an empty claim must not spend the week");
});

test("a cleared goal is nothing to raise", async () => {
    await seed(4, { shortTermGoals: { text: null, previousText: "Learn Kubernetes.", updatedAt: T0 } });
    assert.strictEqual(await claimNudge(4, T0), false, "previousText is history, not a live goal");
});

test("a user with no notes at all is left alone", async () => {
    await seed(5, null);
    assert.strictEqual(await claimNudge(5, T0), false);
    assert.strictEqual((await db.collection("users").findOne({ userId: 5 })).notes, undefined,
        "the claim must not create a notes object on someone who has none");
});

test("any nudgeable section is enough on its own", async () => {
    let userId = 10;
    for (const section of NUDGEABLE_SECTIONS) {
        await seed(userId, { [section]: note("Something to work towards.") });
        assert.strictEqual(await claimNudge(userId, T0), true, `${section} alone should be raisable`);
        userId++;
    }
});

test("an unknown user claims nothing", async () => {
    assert.strictEqual(await claimNudge(999, T0), false);
});

test("a non-integer userId is refused before any query", async () => {
    await assert.rejects(() => claimNudge("1", T0), /integer/);
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
