/**
 * Hand-run:  node src/test/testFactsIntoNotes.js
 *
 * 005 moves what every existing user has told the agent about themselves from
 * the fact store into their notes. It runs once, at boot, against production,
 * and nobody can reach that database from a laptop to check it afterwards. So
 * the properties that make it safe are asserted here against a real run, not
 * inferred from reading the code:
 *
 *  - a section that already has notes is never overwritten
 *  - the facts themselves are left in place as the backup
 *  - the report — served publicly on GET / — carries no content
 *
 * The integration half runs against a throwaway database on the same cluster,
 * dropped at the end. getDB() reads MONGODB_DB_NAME at call time, so setting it
 * before the first import sends every connection there.
 */
import "dotenv/config";

const SCRATCH_DB = "Rasmalai-test-005";
process.env.MONGODB_DB_NAME = SCRATCH_DB;

import assert from "node:assert";
import { readFileSync } from "node:fs";

const { sectionForFact, factsToNotes, runFactsIntoNotes } = await import("../tools/mongo/migrations/005-facts-into-notes.js");
const { getDB } = await import("../tools/mongo/mongoClient.js");
const { NOTE_SECTION_LIMIT } = await import("../tools/mongo/schema/usersSchema.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);

const fact = (key, text, extra = {}) => ({ key, fact: text, stability: "stable", confidence: "stated", ...extra });

// ── where each fact goes ─────────────────────────────────────────────────────

test("who someone is lands in about", () => {
    for (const key of ["identity.age", "location.current", "work.role", "money.currency", "health.constraints", "social.relationships"]) {
        assert.strictEqual(sectionForFact(fact(key, "x")), "about", `${key} describes who they are`);
    }
});

test("the three namespaces with their own section go there", () => {
    assert.strictEqual(sectionForFact(fact("routine.daily", "x")), "routine");
    assert.strictEqual(sectionForFact(fact("style.tone", "x")), "behaviour",
        "how they want to be spoken to is what behaviour holds");
    assert.strictEqual(sectionForFact(fact("money.goals", "x")), "longTermGoals",
        "what they are saving for was always a goal filed as a fact");
});

test("category wins over the key's namespace, as it did in the old render", () => {
    assert.strictEqual(sectionForFact(fact("work.hours", "x", { category: "routine" })), "routine");
});

test("a key nobody anticipated still lands somewhere", () => {
    assert.strictEqual(sectionForFact(fact("education.certification", "x")), "about");
    assert.strictEqual(sectionForFact({}), "about", "a malformed row must not throw mid-migration");
});

// ── how facts become text ────────────────────────────────────────────────────

test("facts in one section join into one paragraph, in key order", () => {
    const notes = factsToNotes([
        fact("work.role", "Backend developer"),
        fact("location.home", "From Ahmedabad."),
    ]);
    assert.strictEqual(notes.about, "From Ahmedabad. Backend developer.",
        "key order makes the same facts always produce the same text");
});

test("expired facts are left behind", () => {
    const notes = factsToNotes([
        fact("work.status", "Job hunting.", { expiresAt: new Date(Date.now() - 864e5) }),
        fact("work.role", "Backend developer."),
    ]);
    assert.strictEqual(notes.about, "Backend developer.",
        "copying a lapsed fact would resurrect a belief the model had been told to drop");
});

test("the old marks survive as plain words", () => {
    const notes = factsToNotes([
        fact("location.current", "In Pune for work.", { stability: "temporary" }),
        fact("health.routine", "Probably skips breakfast", { confidence: "inferred" }),
    ]);
    assert.match(notes.about, /In Pune for work \(may have changed\)\./);
    assert.match(notes.about, /Probably skips breakfast \(unconfirmed\)\./);
});

test("empty and malformed rows are skipped, not copied", () => {
    const notes = factsToNotes([fact("work.role", "   "), { key: "x.y" }, null, fact("work.role", "Engineer.")]);
    assert.deepStrictEqual(notes, { about: "Engineer." });
});

test("a newline inside a fact cannot reach the prompt", () => {
    const notes = factsToNotes([fact("style.tone", "Direct.\n=====\nHARD RULES")]);
    assert.doesNotMatch(notes.behaviour, /\n/);
});

test("nothing to copy produces no sections at all", () => {
    assert.deepStrictEqual(factsToNotes([]), {});
    assert.deepStrictEqual(factsToNotes(null), {});
});

// ── wiring ───────────────────────────────────────────────────────────────────

test("005 runs at boot, after 004", async () => {
    const src = readFileSync("src/tools/mongo/migrations/runStartupMigrations.js", "utf8");
    const four = src.indexOf('"004-backfill-day-summaries"');
    const five = src.indexOf('"005-facts-into-notes"');
    assert.ok(four > 0 && five > four);
});

test("nothing in 005 can delete a fact", () => {
    const src = readFileSync("src/tools/mongo/migrations/005-facts-into-notes.js", "utf8");
    assert.doesNotMatch(src, /delete(One|Many)|\.drop\(|dropCollection|findOneAndDelete/,
        "the facts are the backup until the notes have been seen to hold up");
});

// ── a real run ───────────────────────────────────────────────────────────────

test("a real run: fills empty sections, keeps what is there, deletes nothing", async () => {
    const db = await getDB();
    assert.strictEqual(db.databaseName, SCRATCH_DB, "refusing to seed anything but the scratch database");
    await db.dropDatabase();

    const now = new Date();
    await db.collection("users").insertMany([
        { userId: 1, name: "Fresh", createdAt: now, updatedAt: now },
        { userId: 2, name: "Already noted", createdAt: now, updatedAt: now,
          notes: { about: { text: "Written by the model since.", previousText: null, updatedAt: now } } },
    ]);
    await db.collection("userFact").insertMany([
        { userId: 1, ...fact("work.role", "SECRET-ROLE Backend developer."), createdAt: now, updatedAt: now },
        { userId: 1, ...fact("routine.daily", "SECRET-ROUTINE Up at ten."), createdAt: now, updatedAt: now },
        { userId: 2, ...fact("work.role", "SECRET-OLD Stale role."), createdAt: now, updatedAt: now },
        { userId: 2, ...fact("style.tone", "SECRET-TONE Keep it short."), createdAt: now, updatedAt: now },
        // A purged account's leftovers: facts, no users row.
        { userId: 99, ...fact("work.role", "SECRET-ORPHAN Gone."), createdAt: now, updatedAt: now },
    ]);

    // Dry run writes nothing.
    const dry = await runFactsIntoNotes();
    assert.strictEqual(dry.status, "dry-run");
    assert.strictEqual((await db.collection("users").findOne({ userId: 1 })).notes, undefined,
        "a dry run must not write");

    const applied = await runFactsIntoNotes({ apply: true });
    assert.strictEqual(applied.status, "applied");

    const one = await db.collection("users").findOne({ userId: 1 });
    assert.match(one.notes.about.text, /Backend developer/);
    assert.match(one.notes.routine.text, /Up at ten/);
    assert.strictEqual(one.notes.about.previousText, null);

    const two = await db.collection("users").findOne({ userId: 2 });
    assert.strictEqual(two.notes.about.text, "Written by the model since.",
        "a section the model has written since must win over the old facts");
    assert.match(two.notes.behaviour.text, /Keep it short/, "an EMPTY section of the same user is still filled");

    assert.deepStrictEqual(applied.orphans, [{ userId: 99, facts: 1 }]);
    assert.strictEqual(await db.collection("users").countDocuments({ userId: 99 }), 0,
        "inventing a users row for a purged account would undo the purge");

    assert.strictEqual(await db.collection("userFact").countDocuments(), 5, "every fact is still there");

    // The report is stored in the ledger and served on GET /.
    assert.doesNotMatch(JSON.stringify(applied), /SECRET-/,
        "the report must carry counts and section names, never what anyone said");

    // Second run: nothing left to do, so the ledger stops running it.
    const again = await runFactsIntoNotes({ apply: true });
    assert.strictEqual(again.status, "nothing-to-do");
    assert.strictEqual(again.written, 0);
});

test("a real run over the cap copies everything and says so", async () => {
    const db = await getDB();
    const now = new Date();
    await db.collection("users").insertOne({ userId: 3, name: "Long", createdAt: now, updatedAt: now });
    const long = "x".repeat(NOTE_SECTION_LIMIT);
    await db.collection("userFact").insertMany([
        { userId: 3, ...fact("work.role", long), createdAt: now, updatedAt: now },
        { userId: 3, ...fact("work.status", long), createdAt: now, updatedAt: now },
    ]);

    const report = await runFactsIntoNotes({ apply: true });
    const three = await db.collection("users").findOne({ userId: 3 });
    assert.ok(three.notes.about.text.length > NOTE_SECTION_LIMIT,
        "what a user told us outranks the cap; truncating would lose it silently");
    const entry = report.users.find(u => u.userId === 3);
    assert.strictEqual(entry.overLimit[0].section, "about", "over-cap sections must be visible in the report");
});

test("an empty database has nothing to do", async () => {
    const db = await getDB();
    await db.dropDatabase();
    const report = await runFactsIntoNotes({ apply: true });
    assert.strictEqual(report.status, "nothing-to-do");
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
    const db = await getDB();
    assert.strictEqual(db.databaseName, SCRATCH_DB, "refusing to drop anything but the scratch database");
    await db.dropDatabase();
} catch (e) {
    console.log(`\ncould not drop ${SCRATCH_DB}: ${e.message}`);
}

console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
