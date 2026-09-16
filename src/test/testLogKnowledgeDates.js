/**
 * Hand-run:  node src/test/testLogKnowledgeDates.js
 *
 * The diet, expense and task log blocks the morning routine plans from must
 * date each row as the day it was logged. They sliced toISOString(), and a row
 * stored at IST midnight is the previous day in UTC — every day was shown one
 * day early. Writes one row of each to Rasmalai-eval under a throwaway userId
 * and deletes them.
 */
import "dotenv/config";
import assert from "node:assert";

process.env.MONGODB_DB_NAME = "Rasmalai-eval";

const { getDB } = await import("../tools/mongo/mongoClient.js");
const { localDateOf, localDayRange, previousDay } = await import("../tools/mongo/dateUtils.js");
const { default: dietLogKnowledge } = await import("../knowledge/dietLogKnowledge.js");
const { default: expenseLogKnowledge } = await import("../knowledge/expenseLogknowledge.js");
const { default: taskLogKnowledge } = await import("../knowledge/taskLogKnowledge.js");

const USER = 900041;
const db = await getDB();
if (/prod/i.test(db.databaseName)) throw new Error(`refusing to write to ${db.databaseName}`);
const COLLECTIONS = ["dietRegister", "expenseRegister", "taskRegister"];
const cleanup = () => Promise.all(COLLECTIONS.map(c => db.collection(c).deleteMany({ userId: USER })));

const today = localDateOf(new Date());
const { start } = localDayRange(today);
const yesterday = previousDay(today);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const datesIn = (text) => [...String(text).matchAll(/"date":"([^"]+)"/g)].map(m => m[1]);

test("diet log dates the row as the day it was logged", async () => {
    const dates = datesIn(await dietLogKnowledge(USER));
    assert.ok(dates.includes(today), `expected ${today}, got ${JSON.stringify(dates)}`);
    assert.ok(!dates.includes(yesterday), `one day early: ${yesterday}`);
});

test("expense log dates the row as the day it was logged", async () => {
    const dates = datesIn(await expenseLogKnowledge(USER));
    assert.ok(dates.includes(today), `expected ${today}, got ${JSON.stringify(dates)}`);
    assert.ok(!dates.includes(yesterday), `one day early: ${yesterday}`);
});

test("task log dates the row as the day it was logged", async () => {
    const dates = datesIn(await taskLogKnowledge(USER));
    assert.ok(dates.includes(today), `expected ${today}, got ${JSON.stringify(dates)}`);
    assert.ok(!dates.includes(yesterday), `one day early: ${yesterday}`);
});

test("bookkeeping timestamps stay out of the blocks", async () => {
    for (const text of [await dietLogKnowledge(USER), await taskLogKnowledge(USER)]) {
        assert.ok(!/updatedAt/.test(text), "updatedAt leaked into a planning block");
    }
});

let pass = 0;
try {
    await cleanup();
    const now = new Date();
    await db.collection("dietRegister").insertOne({ userId: USER, date: start, month: "x", year: 2026, meals: [], dailyTotals: { caloriesConsumed: 0, protein: 0, carbs: 0, fat: 0 }, createdAt: now, updatedAt: now });
    await db.collection("expenseRegister").insertOne({ userId: USER, name: "coke", amount: 30, category: "Food", date: start, month: "x", year: 2026, createdAt: now });
    await db.collection("taskRegister").insertOne({ userId: USER, date: start, day: "x", performedTasks: [], createdAt: now, updatedAt: now });
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`PASS  ${name}`); }
        catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
    }
} finally {
    await cleanup();
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
