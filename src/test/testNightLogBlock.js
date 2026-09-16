/**
 * Hand-run:  node src/test/testNightLogBlock.js
 *
 * The LOGGED SO FAR block the night routine reads every turn. Pure — no .env,
 * no database — except the last test, which only checks buildFlowOverlay hands
 * the flow to buildContext.
 */
import assert from "node:assert";
import { renderLoggedSoFar, normaliseNothingToLog } from "../knowledge/nightLogKnowledge.js";
import { buildFlowOverlay } from "../agent/agent.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const DIET = [{
    _id: "66f2a1aaaaaaaaaaaaaaaaaa",
    meals: [
        { mealType: "Lunch", items: [{ name: "dal chawal" }], mealCalories: 450 },
        { mealType: "Dinner", items: [{ name: "pizza" }, { name: "pasta" }], mealCalories: 1100 },
    ],
    dailyTotals: { caloriesConsumed: 1550 },
}];
const TASKS = [{ _id: "66f3b0bbbbbbbbbbbbbbbbbb", performedTasks: [{ title: "Q3 deck review", status: "Completed", actualDurationMinutes: 120 }] }];
const EXPENSES = [
    { _id: "66f4c2cccccccccccccccccc", amount: 30, category: "Food", name: "Coke bottle" },
    { _id: "66f4c3cccccccccccccccccc", amount: 50, category: "Travel", name: "rickshaw" },
];

test("every saved row is listed with the _id a correction needs", () => {
    const b = renderLoggedSoFar({ logDate: "2026-09-16", diet: DIET, tasks: TASKS, expenses: EXPENSES });
    for (const id of ["66f2a1aaaaaaaaaaaaaaaaaa", "66f3b0bbbbbbbbbbbbbbbbbb", "66f4c2cccccccccccccccccc", "66f4c3cccccccccccccccccc"]) {
        assert.ok(b.includes(id), `missing ${id}`);
    }
});

test("the expense total is added up here, not left to the model", () => {
    assert.match(renderLoggedSoFar({ logDate: "d", expenses: EXPENSES }), /Total ₹80/);
});

test("a missing main meal is still open; logged ones are not", () => {
    const b = renderLoggedSoFar({ logDate: "d", diet: DIET, tasks: TASKS, expenses: EXPENSES });
    assert.match(b, /STILL OPEN: breakfast$/m);
});

test("a declined meal stops being open", () => {
    const b = renderLoggedSoFar({ logDate: "d", diet: DIET, tasks: TASKS, expenses: EXPENSES, nothingToLog: ["breakfast"] });
    assert.match(b, /STILL OPEN: nothing/);
    assert.match(b, /NOTHING TO LOG FOR: breakfast/);
});

test("an empty day lists everything as open", () => {
    const b = renderLoggedSoFar({ logDate: "d" });
    assert.match(b, /STILL OPEN: breakfast, lunch, dinner · work done today · spending/);
});

test("the model's near-miss words still count as declined", () => {
    assert.deepStrictEqual(normaliseNothingToLog(["Tasks", "spending", "meals", "nonsense"]).sort(), ["expenses", "food", "work"]);
    const b = renderLoggedSoFar({ logDate: "d", nothingToLog: ["tasks", "spending", "food"] });
    assert.match(b, /STILL OPEN: nothing/);
});

test("the block tells the model to trust it over memory, both ways", () => {
    const b = renderLoggedSoFar({ logDate: "d" });
    assert.match(b, /never save it a second time, even worded differently/);
    assert.match(b, /Only something clearly absent below/);
});

test("the day's plan is shown when there is one", () => {
    const b = renderLoggedSoFar({ logDate: "d", schedule: { slots: [{ startTime: "19:00", endTime: "20:00", title: "Gym" }] } });
    assert.match(b, /19:00–20:00  Gym/);
});

test("buildFlowOverlay hands the flow itself to buildContext", async () => {
    let seen;
    const flows = { goodNight: { instruction: "X", buildContext: async (_u, opts) => { seen = opts.flow; return "CTX"; } } };
    const flow = { flowType: "goodNight", startedAt: new Date(), scratchpad: { nothingToLog: ["work"] } };
    const overlay = await buildFlowOverlay(flow, { userId: 1, flows });
    assert.strictEqual(seen, flow);
    assert.ok(overlay.includes("CTX"));
});

let pass = 0;
for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log(`PASS  ${name}`); }
    catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
