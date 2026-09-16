/**
 * Hand-run:  node src/test/testTaskLog.js
 *
 * addPerformedTask appends one task to the day and never erases the rest.
 * Pure half needs nothing; database half writes to Rasmalai-eval under a
 * throwaway userId and deletes what it made.
 */
import "dotenv/config";
import assert from "node:assert";

process.env.MONGODB_DB_NAME = "Rasmalai-eval";

const { buildPerformedTask, addPerformedTask } = await import("../tools/mongo/operation/taskLog.js");
const { getDB, ensureIndexes } = await import("../tools/mongo/mongoClient.js");

const USER = 900004;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("defaults: Completed, General, no taskId", () => {
    assert.deepStrictEqual(
        buildPerformedTask({ title: " deck review ", actualDurationMinutes: 120 }),
        { taskId: null, title: "deck review", category: "General", status: "Completed", actualDurationMinutes: 120 }
    );
});

test("a missing duration is sent back to be asked, never guessed", () => {
    assert.throws(() => buildPerformedTask({ title: "deck" }), /Ask the user roughly how long/);
});

test("a taskId that is not an id is refused", () => {
    assert.throws(() => buildPerformedTask({ title: "x", actualDurationMinutes: 5, taskId: "task_1" }), /not an id/);
});

test("times must be HH:mm", () => {
    assert.throws(() => buildPerformedTask({ title: "x", actualDurationMinutes: 5, actualFrom: "2pm" }), /HH:mm/);
});

let db;
const docs = () => db.collection("taskRegister").find({ userId: USER }).toArray();
const cleanup = () => db.collection("taskRegister").deleteMany({ userId: USER });

test("the first task creates the day, with its day name", async () => {
    const r = await addPerformedTask(USER, { title: "standup", actualDurationMinutes: 30 });
    const [doc] = await docs();
    assert.strictEqual(doc.performedTasks.length, 1);
    assert.strictEqual(doc.day, new Date(`${r.date}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long" }));
});

test("a later task is APPENDED — the first survives", async () => {
    await addPerformedTask(USER, { title: "Q3 deck review", actualDurationMinutes: 120 });
    const [doc] = await docs();
    assert.deepStrictEqual(doc.performedTasks.map(t => t.title), ["standup", "Q3 deck review"]);
});

test("the same work again is reported as a duplicate, not added", async () => {
    const r = await addPerformedTask(USER, { title: "  q3 DECK review ", actualDurationMinutes: 90 });
    assert.strictEqual(r.duplicate, true);
    const [doc] = await docs();
    assert.strictEqual(doc.performedTasks.length, 2);
});

test("the same title twice in parallel still lands once", async () => {
    await cleanup();
    await Promise.all([
        addPerformedTask(USER, { title: "login bug", actualDurationMinutes: 180 }),
        addPerformedTask(USER, { title: "login bug", actualDurationMinutes: 180 }),
    ]);
    const all = await docs();
    assert.strictEqual(all.length, 1, `${all.length} documents for one day`);
    assert.strictEqual(all[0].performedTasks.length, 1);
});

test("different tasks in parallel all land on one document", async () => {
    await cleanup();
    await Promise.all(["a", "b", "c"].map(t => addPerformedTask(USER, { title: t, actualDurationMinutes: 10 })));
    const all = await docs();
    assert.strictEqual(all.length, 1);
    assert.deepStrictEqual(all[0].performedTasks.map(t => t.title).sort(), ["a", "b", "c"]);
});

let pass = 0;
try {
    db = await getDB();
    if (/prod/i.test(db.databaseName)) throw new Error(`refusing to write to ${db.databaseName}`);
    await ensureIndexes();
    await cleanup();
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`PASS  ${name}`); }
        catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
    }
} finally {
    if (db) await cleanup();
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
