/**
 * Hand-run:  node src/test/testRefileFacts.js
 *
 * 007 rewrites notes on prod at boot, so it is run for real against a scratch
 * database: facts are seeded, 005 copies them the way it did on prod, and 007
 * re-files them. The facts here are made up; the shape — a housing fact the
 * model had labelled "routine" — is the one prod had.
 *
 * Uses its own throwaway database — it DROPS it at the start and the end, so it
 * must never share one with the other guards.
 */
import "dotenv/config";

const SCRATCH_DB = "Rasmalai-test-007";
process.env.MONGODB_DB_NAME = SCRATCH_DB;

import assert from "node:assert";

const { runFactsIntoNotes, factsToNotes } = await import("../tools/mongo/migrations/005-facts-into-notes.js");
const { runRefileFactsByKey, planRefile, sectionForFactKey } = await import("../tools/mongo/migrations/007-refile-facts-by-key.js");
const { getDB } = await import("../tools/mongo/mongoClient.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);

const HOUSING = { key: "housing.storage", category: "routine", stability: "temporary", fact: "Renting a storage unit until the flat is ready" };
const HEALTH = { key: "health.diet", category: "health", stability: "stable", fact: "Avoids gluten" };
const DAY = { key: "routine.daily", stability: "stable", fact: "Up at 7 on weekdays" };

// ── pure ────────────────────────────────────────────────────────────────────

test("the key decides, never the model's category", () => {
    assert.strictEqual(sectionForFactKey(HOUSING), "about", "housing.* is about, whatever it was labelled");
    assert.strictEqual(sectionForFactKey(DAY), "routine");
    assert.strictEqual(sectionForFactKey({ key: "style.tone", category: "work" }), "behaviour");
    assert.strictEqual(sectionForFactKey({ key: "money.goals" }), "longTermGoals");
});

test("005 still files by category, so its own copy is unchanged", () => {
    const copy = factsToNotes([HOUSING, HEALTH], 0);
    assert.match(copy.routine, /storage unit/, "the misfile 007 exists to correct");
    assert.doesNotMatch(copy.about, /storage unit/);
});

const at = new Date("2026-09-16T21:00:08Z");
const notesFrom = (copy, when = at) =>
    Object.fromEntries(Object.entries(copy).map(([section, text]) => [section, { text, previousText: null, updatedAt: when }]));

test("a copy still as 005 left it is re-filed by key", () => {
    const facts = [HOUSING, HEALTH];
    const plan = planRefile(facts, notesFrom(factsToNotes(facts, at.getTime())));
    assert.strictEqual(plan.status, "refile");
    assert.strictEqual(plan.moves.routine.to, null, "nothing else was filed under routine, so it empties");
    assert.match(plan.moves.about.to, /Avoids gluten\. Renting a storage unit/);
});

test("a section rewritten since the copy is theirs", () => {
    const facts = [HOUSING, HEALTH];
    const notes = notesFrom(factsToNotes(facts, at.getTime()));
    notes.routine = { text: "Up at 6, gym, office 9 to 6. Renting a storage unit.", previousText: notes.routine.text, updatedAt: new Date() };
    assert.deepStrictEqual(planRefile(facts, notes), { status: "rewritten-since", rewritten: ["routine"], moves: {} });
});

test("nothing to do when key and category agree, or the notes never came from facts", () => {
    const facts = [HEALTH, DAY];
    assert.strictEqual(planRefile(facts, notesFrom(factsToNotes(facts, at.getTime()))).status, "already-by-key");
    assert.strictEqual(planRefile(facts, notesFrom({ about: "Written by the model." })).status, "not-from-facts");
    assert.strictEqual(planRefile(facts, undefined).status, "not-from-facts");
});

// ── against a database ──────────────────────────────────────────────────────

let db;
const users = () => db.collection("users");
const seedFacts = (userId, facts) => db.collection("userFact").insertMany(facts.map(f => ({ userId, ...f, createdAt: at, updatedAt: at })));

test("a real run: dry first, then only the untouched copy is re-filed, once", async () => {
    db = await getDB();
    assert.strictEqual(db.databaseName, SCRATCH_DB, "refusing to seed anything but the scratch database");
    await db.dropDatabase();

    await users().insertMany([1, 2, 3].map(userId => ({ userId, name: `U${userId}`, createdAt: at, updatedAt: at })));
    await seedFacts(1, [HOUSING, HEALTH]);   // the prod shape
    await seedFacts(2, [HOUSING, HEALTH]);   // same, but rewritten since
    await seedFacts(3, [HEALTH, DAY]);       // nothing misfiled
    await runFactsIntoNotes({ apply: true });
    await users().updateOne({ userId: 2 }, { $set: { "notes.routine.text": "Up at 6, gym, office 9 to 6.", "notes.routine.updatedAt": new Date() } });
    const before = await users().find().sort({ userId: 1 }).toArray();

    const dry = await runRefileFactsByKey();
    assert.strictEqual(dry.status, "dry-run");
    assert.deepStrictEqual(dry.refiled, [{ userId: 1, sections: ["about", "routine"] }]);
    assert.deepStrictEqual(dry.skipped, [{ userId: 2, reason: "rewritten-since", sections: ["routine"] }]);
    assert.deepStrictEqual(await users().find().sort({ userId: 1 }).toArray(), before, "a dry run writes nothing");

    const applied = await runRefileFactsByKey({ apply: true });
    assert.strictEqual(applied.status, "applied");
    const one = await users().findOne({ userId: 1 });
    assert.strictEqual(one.notes.routine.text, null);
    assert.match(one.notes.routine.previousText, /storage unit/, "what it said is one step back, not gone");
    assert.match(one.notes.about.text, /Avoids gluten\. Renting a storage unit until the flat is ready \(may have changed\)\./);

    const others = await users().find({ userId: { $in: [2, 3] } }).sort({ userId: 1 }).toArray();
    assert.deepStrictEqual(others, before.slice(1), "a rewritten section and a clean copy are both left exactly as they were");

    const again = await runRefileFactsByKey({ apply: true });
    assert.strictEqual(again.status, "nothing-to-do");
    assert.deepStrictEqual(again.refiled, []);
});

test("the report names users and sections, never what they said", async () => {
    const report = JSON.stringify(await runRefileFactsByKey());
    for (const words of ["storage", "gluten", "Up at"]) assert.ok(!report.includes(words), `report leaks "${words}"`);
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
