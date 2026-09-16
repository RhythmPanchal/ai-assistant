/**
 * Hand-run:  node src/test/testNightOpener.js
 *
 * The night opener falls back to the template on every kind of failure. No
 * model, no database: the agent run is injected.
 *
 * A night with no opener is a night with nothing logged, so the one property
 * worth pinning is that composeNightOpener never throws and never delivers a
 * canned runAgent substitute as if it were a greeting.
 */
import "dotenv/config";
import assert from "node:assert";
import { composeNightOpener } from "../scheduler/jobs/goodNightJob.js";
import { STEP_LIMIT_REPLY, WORK_DONE_REPLY } from "../agent/agent.js";
import { NO_REPLY } from "../agent/instruction.js";
import goodNightFlow, { NIGHT_TRIGGER } from "../agent/flows/goodNightFlow.js";

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const replying = (text) => async () => ({ text, metrics: {} });

const TEMPLATE = goodNightFlow.openerMessage;

test("a written opener is sent as written", async () => {
    const r = await composeNightOpener(1, "Asia/Kolkata", { run: replying("  How was the office party? Did you eat there?  ") });
    assert.deepStrictEqual(r, { text: "How was the office party? Did you eat there?", generated: true });
});

for (const [label, reply] of [
    ["NO_REPLY", NO_REPLY],
    ["the step-limit substitute", STEP_LIMIT_REPLY],
    ["the work-done substitute", WORK_DONE_REPLY],
    ["an empty reply", "   "],
    ["a fragment", "Hi"],
    ["nothing at all", undefined],
]) {
    test(`${label} falls back to the template`, async () => {
        const r = await composeNightOpener(1, "Asia/Kolkata", { run: replying(reply) });
        assert.deepStrictEqual(r, { text: TEMPLATE, generated: false });
    });
}

test("a thrown error falls back to the template instead of propagating", async () => {
    const r = await composeNightOpener(1, "Asia/Kolkata", { run: async () => { throw new Error("quota"); } });
    assert.deepStrictEqual(r, { text: TEMPLATE, generated: false });
});

test("the run is sent the night trigger, as the job, with a bound identity", async () => {
    let seen;
    await composeNightOpener(42, "Asia/Kolkata", {
        run: async (userId, text, source) => {
            const { getUserContext } = await import("../identity/userContext.js");
            seen = { userId, text, source, ctx: getUserContext().userId };
            return { text: "How did today go, anything fun?" };
        },
    });
    assert.deepStrictEqual(seen, { userId: 42, text: NIGHT_TRIGGER, source: "goodNightJob", ctx: 42 });
});

test("the overlay tells the opener turn to call no tools and invent nothing", () => {
    assert.match(goodNightFlow.instruction, /Call NO tools on this turn/);
    assert.match(goodNightFlow.instruction, /Never invent an event/);
});

let pass = 0;
for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log(`PASS  ${name}`); }
    catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
