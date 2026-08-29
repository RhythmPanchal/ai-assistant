/**
 * Hand-run:  node src/test/testTaskHygiene.js
 *
 * Everything that had to change so that "arrey ye to ho gaya" actually closes a
 * task. Needs .env for MONGO_DB_URI (mongoClient builds its client at import)
 * but never connects — nothing here touches the database.
 *
 * The failure being guarded against, in one line: on 2026-08-22 the user said a
 * task was already done, the agent said "Got it", and the task was still Pending
 * ten days and four morning schedules later.
 */
import "dotenv/config";
import assert from "node:assert";

const tests = [];
const test = (n, f) => tests.push([n, f]);

const { isRoutineBlock, ROUTINE_CATEGORY } = await import("../tools/mongo/operation/routineBlock.js");
const { formatPendingTasksForLLM } = await import("../knowledge/pendingTasksKnowledge.js");
const { goodMorningFlow } = await import("../agent/flows/goodMorningFlow.js");
const { buildFlowOverlay, flowStateBlock } = await import("../agent/agent.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;

const NOW = new Date("2026-08-29T09:30:00+05:30");
const task = (over) => ({
    _id: "68a1b2c3d4e5f60718293a4b", title: "A task", priorityScore: 2,
    status: "Pending", createdAt: new Date("2026-08-20"), ...over,
});

// ── routine blocks ───────────────────────────────────────────────────────────

test("blocks of the day are recognised as such", () => {
    for (const title of [
        "Personal time / catch up", "Lunch Break", "Dinner & Unwind", "Unwind & Sleep",
        "Morning Routine & Breakfast", "Rest / Down Time", "Wrap up & Review", "Free time",
        "Travel & Unwind", "Personal: Relax",
    ]) {
        assert.ok(isRoutineBlock(title), `"${title}" must never reach taskCalendar — it cannot be completed`);
    }
});

test("real work is never mistaken for furniture", () => {
    // A false positive here refuses a task the user actually asked for, which is
    // far worse than letting one more "Free time" row through.
    for (const title of [
        "Book a dinner reservation", "Buy a table & lamp", "Review Sameer's PR",
        "Watch Kubernetes tutorials (Harkirat)", "Travel to Delhi for the wedding",
        "Move compaction changes to lowes prod", "Team sync", "Decide and buy a table",
    ]) {
        assert.ok(!isRoutineBlock(title), `"${title}" is real work and was refused`);
    }
});

// ── the backlog the model reads ──────────────────────────────────────────────

test("every pending task carries a real id", () => {
    // Stripping _id for token thrift is what made the list unaddressable: HARD
    // RULE 2 forbids inventing one, so the model could read the backlog and not
    // name a single row of it to a tool.
    const out = formatPendingTasksForLLM([task()], NOW);
    assert.match(out, /68a1b2c3d4e5f60718293a4b/, "no id — nothing in this list can be updated");
    assert.match(out, /updateTaskStatus/, "the list must say what the id is for");
});

test("lateness is stated in days, not left as a date to subtract", () => {
    const out = formatPendingTasksForLLM([
        task({ deadline: new Date("2026-06-10T00:00:00+05:30"), title: "Harkirat" }),
    ], NOW);
    assert.match(out, /OVERDUE 80d/, "a bare date reads like any other date; 80 days does not");
});

test("worst first — the most overdue task leads the list", () => {
    const lines = formatPendingTasksForLLM([
        task({ _id: "aaa", title: "Fresh", priorityScore: 1 }),
        task({ _id: "bbb", title: "Ancient", priorityScore: 5, deadline: new Date("2026-06-10T00:00:00+05:30") }),
        task({ _id: "ccc", title: "Late", priorityScore: 1, deadline: new Date("2026-08-25T00:00:00+05:30") }),
    ], NOW).split("\n").slice(1);
    assert.match(lines[0], /Ancient/, "80 days late must outrank priority 1");
    assert.match(lines[1], /Late/);
    assert.match(lines[2], /Fresh/);
});

test("avoidance signals are visible", () => {
    const pushed = formatPendingTasksForLLM([task({ deferCount: 3 })], NOW);
    assert.match(pushed, /PUSHED BACK 3x/, "a task pushed three times is being avoided, not planned");

    const stale = formatPendingTasksForLLM([task({ createdAt: new Date("2026-06-01") })], NOW);
    assert.match(stale, /STALE opened \d+d ago/, "no deadline is how a task hides forever");
});

// ── a completed task points at the task it completed ─────────────────────────

test("taskRegister.taskId is a reference, not a per-day label", async () => {
    const schema = (await import("../tools/mongo/schema/taskRegisterSchema.js")).default;
    const taskId = schema.properties.performedTasks.items.properties.taskId;

    assert.ok(taskId.bsonType.includes("null"),
        "unplanned work must be able to say so instead of being given a fake id");
    assert.match(taskId.description, /taskCalendar _id/,
        "an undescribed string field is how task_1/task_2 became the convention");
});

test("the day's log keeps the field that links it to the backlog", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/knowledge/taskLogKnowledge.js", "utf8");
    assert.ok(!/const \{ taskId, \.\.\.cleanTask \} = task/.test(src),
        "stripping taskId hides the only link between what was done and what was planned");
});

test("the evening wrap-up closes the task, not just logs the work", async () => {
    const { goodNightFlow } = await import("../agent/flows/goodNightFlow.js");
    assert.match(goodNightFlow.instruction, /CLOSE THE TASK TOO/);
    assert.match(goodNightFlow.instruction, /updateTaskStatus with the TITLE/,
        "the wrap-up has no backlog in context, so it must resolve by title and take the id back");
    assert.match(goodNightFlow.instruction, /Logging alone is not enough/);
});

// ── the tools that were missing ──────────────────────────────────────────────

test("closing and deferring a task are always available, not skill-gated", () => {
    const declared = toolRegistry.getToolDeclarations().map(d => d.name);
    // "compaction ho gaya" arrives at any hour. A backlog only correctable
    // during one routine a day is a backlog that stays wrong.
    assert.ok(declared.includes("updateTaskStatus"), "updateTaskStatus must be declared on every turn");
    assert.ok(declared.includes("deferTask"), "deferTask must be declared on every turn");
    assert.ok(toolRegistry.getTool("updateTaskStatus"), "declared but not executable");
    assert.ok(toolRegistry.getTool("deferTask"), "declared but not executable");
});

test("updateTaskStatus takes a batch and refuses invented ids", () => {
    const { parameters, description } = toolRegistry.getTool("updateTaskStatus").constructor;
    assert.strictEqual(parameters.properties.updates.type, "array",
        "corrections arrive several at a time — 'this is done, drop that one'");
    assert.match(JSON.stringify(parameters), /Never invent an id/);
    assert.match(description, /Pending/, "the model needs to know acknowledging is not enough");
});

// ── the morning overlay ──────────────────────────────────────────────────────

test("the trigger prompt carries no data and no procedure", () => {
    // It used to carry the whole backlog. That froze at 09:00, was stored in
    // chatHistory as a user message, and was replayed on every later turn.
    const prompt = goodMorningFlow.buildTriggerPrompt();
    assert.ok(prompt.length < 200, `trigger prompt is ${prompt.length} chars — data belongs in buildContext`);
    assert.ok(!/DO NOT FETCH/i.test(prompt), "the fetch rule belongs with the data it protects");
    assert.strictEqual(goodMorningFlow.buildTriggerPrompt.length, 0,
        "the job must not have to supply data any more");
});

test("a correction is stated as a tool call, not an acknowledgement", () => {
    const i = goodMorningFlow.instruction;
    assert.match(i, /updateTaskStatus/, "the overlay must name the tool that closes a task");
    assert.match(i, /deferTask/);
    assert.match(i, /TWO calls: close X, create Y/,
        "'X ki jagah Y dal do' created Y and left X Pending — that exact case must be spelled out");
    assert.match(i, /Got it/, "the phrase that was said instead of acting must be named as forbidden");
});

test("the overlay teaches scheduling instead of assuming it", () => {
    const i = goodMorningFlow.instruction;
    assert.match(i, /START FROM NOW/, "a 09:15 slot drafted at 15:50 is dead on arrival");
    assert.match(i, /CAPACITY IS THE CONSTRAINT/, "priority order alone produces a day that breaks by 11am");
    assert.match(i, /FIRST STEP, NOT ITS OWN TITLE/,
        "a 360-minute task has no beginning small enough to start");
    assert.match(i, /taskRef = the id/, "unlinked slots leave the evening wrap-up guessing");
    assert.match(i, new RegExp(ROUTINE_CATEGORY), "furniture needs somewhere legitimate to go");
});

test("slipping work is confronted before the timeline, not after it", () => {
    const i = goodMorningFlow.instruction;
    assert.ok(i.indexOf("SAY WHAT HAS SLIPPED") < i.indexOf("STEP 3 — BUILD THE DAY"),
        "a footnote under the schedule reads as decoration");
    assert.match(i, /OVERDUE by 3 days or more/);
    assert.match(i, /ONE or TWO worst/, "a list of ten gets skimmed");
    assert.match(i, /Do not hold the day hostage/, "confront, then draft anyway");
});

test("the two-strike rule survives, and a correction is not a strike", () => {
    const i = goodMorningFlow.instruction;
    assert.match(i, /FIRST unrelated message/);
    assert.match(i, /SECOND unrelated message/);
    assert.match(i, /updateFlowScratchpad/);
    assert.match(i, /correction to a task is NOT an unrelated message/,
        "closing a task is step 1 of the routine — counting it as a strike would end the routine");
    assert.match(flowStateBlock({ flowType: "goodMorning", scratchpad: { unrelatedReplies: 1 } }),
        /unrelatedReplies so far: 1/);
});

// ── overlay assembly ─────────────────────────────────────────────────────────

test("an overlay is procedure, then state, then live data", async () => {
    const flow = { flowType: "fake", startedAt: new Date("2026-08-29T09:00:00+05:30") };
    const flows = { fake: { instruction: "PROCEDURE", buildContext: async () => "LIVE DATA" } };
    const out = await buildFlowOverlay(flow, { userId: 1, flows });

    assert.ok(out.indexOf("PROCEDURE") < out.indexOf("FLOW STATE"));
    assert.ok(out.indexOf("FLOW STATE") < out.indexOf("LIVE DATA"),
        "data goes last, where recency gives it the most weight");
});

test("a flow with no live data still gets its overlay", async () => {
    const flows = { fake: { instruction: "PROCEDURE" } };
    const out = await buildFlowOverlay({ flowType: "fake", startedAt: new Date() }, { userId: 1, flows });
    assert.match(out, /PROCEDURE/);
    assert.match(out, /FLOW STATE/);
});

test("a context that throws costs the data, never the turn", async () => {
    const flows = {
        fake: {
            instruction: "PROCEDURE\nDo not call fetchRecord for taskCalendar.",
            buildContext: async () => { throw new Error("connection reset"); },
        },
    };
    const out = await buildFlowOverlay({ flowType: "fake", startedAt: new Date() }, { userId: 1, flows });

    assert.match(out, /PROCEDURE/, "the routine must still run");
    assert.match(out, /connection reset/, "say what broke");
    assert.match(out, /Ignore any instruction above that tells you not to fetch/,
        "with no data, the do-not-fetch rule would leave the model with nothing at all");
});

test("an unknown flow contributes nothing rather than throwing", async () => {
    assert.strictEqual(await buildFlowOverlay({ flowType: "notAFlow" }, { userId: 1 }), null);
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
