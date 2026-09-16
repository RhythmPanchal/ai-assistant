/**
 * Hand-run:  node src/test/testDatesForModel.js
 *
 * datesForModel: what a stored date looks like by the time a model reads it.
 * Pure — no network, no database.
 *
 * The regression: a Date serialises as UTC, day-scoped rows are stored at IST
 * midnight, and so every one of them read as the previous day.
 */
import assert from "node:assert";
import { ObjectId } from "mongodb";
import { datesForModel, localDateTimeOf } from "../tools/mongo/dateUtils.js";
import { ToolResult } from "../agent/tools/BaseTool.js";

const IST_MIDNIGHT_17 = new Date("2026-09-16T18:30:00.000Z");
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the bug: a day stored at IST midnight used to serialise as the day before", () => {
    assert.strictEqual(JSON.stringify({ date: IST_MIDNIGHT_17 }), '{"date":"2026-09-16T18:30:00.000Z"}');
});

test("a date field at local midnight reads as its own day", () => {
    assert.deepStrictEqual(datesForModel({ date: IST_MIDNIGHT_17 }), { date: "2026-09-17" });
});

test("any other Date keeps its local time, naive, no Z", () => {
    assert.deepStrictEqual(
        datesForModel({ nextExecutionAt: new Date("2026-09-18T15:30:00.000Z") }),
        { nextExecutionAt: "2026-09-18T21:00:00" }
    );
});

test("a reminder due at local midnight keeps its time", () => {
    assert.deepStrictEqual(datesForModel({ deadline: IST_MIDNIGHT_17 }), { deadline: "2026-09-17T00:00:00" });
});

test("a date field NOT at midnight shows its real time instead of being tidied", () => {
    assert.deepStrictEqual(datesForModel({ date: new Date("2026-09-17T06:00:00.000Z") }), { date: "2026-09-17T11:30:00" });
});

test("ObjectIds become hex, the way they serialised anyway", () => {
    const id = new ObjectId("66f4c2cccccccccccccccccc");
    assert.deepStrictEqual(datesForModel({ _id: id }), { _id: "66f4c2cccccccccccccccccc" });
});

test("nested rows and arrays are converted all the way down", () => {
    const out = datesForModel({ records: [{ date: IST_MIDNIGHT_17, meals: [{ at: new Date("2026-09-17T07:00:00.000Z") }] }] });
    assert.deepStrictEqual(out, { records: [{ date: "2026-09-17", meals: [{ at: "2026-09-17T12:30:00" }] }] });
});

test("a ToolResult becomes a plain object with its dates converted", () => {
    const out = datesForModel(new ToolResult(true, "Fetched 1 records", [{ date: IST_MIDNIGHT_17, amount: 30 }]));
    assert.deepStrictEqual(out, { success: true, message: "Fetched 1 records", data: [{ date: "2026-09-17", amount: 30 }] });
});

test("everything that is not a date is untouched", () => {
    const row = { amount: 30, name: "2026-09-16T18:30:00.000Z", ok: true, none: null, tags: ["a"] };
    assert.deepStrictEqual(datesForModel(row), row);
});

test("an invalid Date becomes null rather than 'Invalid Date'", () => {
    assert.deepStrictEqual(datesForModel({ date: new Date("nope") }), { date: null });
});

test("localDateTimeOf is the inverse of how toIST stores", async () => {
    const { toIST } = await import("../tools/mongo/dateUtils.js");
    assert.strictEqual(localDateTimeOf(toIST("2026-09-18T21:00:00")), "2026-09-18T21:00:00");
});

let pass = 0;
for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log(`PASS  ${name}`); }
    catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
