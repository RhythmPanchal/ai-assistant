/**
 * Hand-run:  node src/test/testRoutineNotes.js
 *
 * The routines may raise one slipping goal a week. claimNudge (testNudgeClaim)
 * decides WHETHER; this is everything around it — that only a routine ever
 * asks, that a turn asks once however many routines are open, that a broken
 * claim costs the nudge and never the turn, and that the permission the model
 * reads cannot be mistaken for an instruction to nag. And the night routine's
 * notes upkeep: that it drifts the routine slowly and never displaces the log.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects: the claim is injected everywhere.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const { routineNudge, NUDGE_BLOCK, ROUTINE_FLOW_TYPES, notesUpkeep, NIGHT_NOTES_BLOCK } = await import("../agent/flows/routineNotes.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;

const tests = [];
const test = (n, f) => tests.push([n, f]);

const counting = (answer) => {
    const claim = async () => { claim.calls++; if (answer instanceof Error) throw answer; return answer; };
    claim.calls = 0;
    return claim;
};
const morning = { flowType: "goodMorning" };
const night = { flowType: "goodNight" };

// ── when a claim is even attempted ───────────────────────────────────────────

test("an ordinary turn never claims", async () => {
    const claim = counting(true);
    assert.strictEqual(await routineNudge([], { userId: 1, claim }), null);
    assert.strictEqual(claim.calls, 0,
        "a normal conversation must not spend the week, nor pay for a write to learn it has nothing to do");
});

test("a flow that is not a routine never claims", async () => {
    const claim = counting(true);
    assert.strictEqual(await routineNudge([{ flowType: "somethingElse" }], { userId: 1, claim }), null);
    assert.strictEqual(claim.calls, 0);
});

test("both routines are routines", () => {
    assert.deepStrictEqual([...ROUTINE_FLOW_TYPES].sort(), ["goodMorning", "goodNight"]);
});

test("either routine can raise a goal when the claim is won", async () => {
    for (const flow of [morning, night]) {
        assert.strictEqual(await routineNudge([flow], { userId: 1, claim: counting(true) }), NUDGE_BLOCK,
            `${flow.flowType} should carry the permission`);
    }
});

test("a lost claim adds nothing", async () => {
    assert.strictEqual(await routineNudge([morning], { userId: 1, claim: counting(false) }), null);
});

test("with both routines open, a turn claims once", async () => {
    // The night flow stays open until 10:00 and the morning one opens at 09:00.
    const claim = counting(true);
    await routineNudge([night, morning], { userId: 1, claim });
    assert.strictEqual(claim.calls, 1, "two claims in one turn would race each other for the same week");
});

test("a claim that throws costs the nudge, never the turn", async () => {
    const out = await routineNudge([morning], { userId: 1, claim: counting(new Error("connection reset")) });
    assert.strictEqual(out, null);
});

test("the claim is made for the user the turn belongs to", async () => {
    let seen;
    await routineNudge([morning], { userId: 42, claim: async (userId) => { seen = userId; return true; } });
    assert.strictEqual(seen, 42);
});

// ── what the model is told ───────────────────────────────────────────────────

test("the permission is for this reply only", () => {
    assert.match(NUDGE_BLOCK, /this reply only/);
    assert.match(NUDGE_BLOCK, /not get this chance again this week/,
        "without it the model raises the goal again on the next turn of the same routine");
});

test("it is one short line, never a second question", () => {
    // "You may raise one" alone was read as optional: in the live eval the
    // model skipped a habit missed five nights running. The block now says
    // what to do when something has slipped, with a worked example.
    assert.match(NUDGE_BLOCK, /ONE habit or goal/);
    assert.match(NUDGE_BLOCK, /end this reply with one short line/);
    assert.doesNotMatch(NUDGE_BLOCK, /rasmalai/i, "the example must not be what the live eval grades");
    assert.match(NUDGE_BLOCK, /do not add a second question/,
        "the morning message already asks about a slipping task; two questions is an interview");
});

test("nothing slipping, or a hard day, means saying nothing", () => {
    assert.match(NUDGE_BLOCK, /say nothing\s+about goals/);
    assert.match(NUDGE_BLOCK, /overloaded/,
        "the agent absorbs overwhelm; a goal reminder on a bad day is piling on");
});

test("the block asks for no tool call", () => {
    // The cooldown is spent by the claim, so the model never has to report back
    // — and a block naming a tool is a block the opener's no-tools rule breaks.
    const named = [...NUDGE_BLOCK.matchAll(/\b([a-z]+[A-Z]\w*)\b/g)].map(m => m[1]);
    for (const name of named) {
        assert.ok(!toolRegistry.getTool(name), `the nudge block should not name the tool ${name}`);
    }
});

// ── the night routine keeps the notes ────────────────────────────────────────

test("only the night routine is asked to keep the notes", () => {
    assert.strictEqual(notesUpkeep([night]), NIGHT_NOTES_BLOCK);
    assert.strictEqual(notesUpkeep([night, morning]), NIGHT_NOTES_BLOCK, "the morning overlap does not hide it");
    assert.strictEqual(notesUpkeep([morning]), null,
        "the morning routine already notes durable corrections in its refine loop");
    assert.strictEqual(notesUpkeep([]), null);
    assert.strictEqual(notesUpkeep(null), null);
});

test("the routine section drifts slowly", () => {
    assert.match(NIGHT_NOTES_BLOCK, /drifts slowly/);
    assert.match(NIGHT_NOTES_BLOCK, /One late night or one early start is not a new\s+routine/,
        "one outlier night must not rewrite what the model asserts every morning");
    assert.match(NIGHT_NOTES_BLOCK, /several\s+days in RECENTLY/, "the evidence it may use must be named");
});

test("most nights change nothing, and the notes are left alone", () => {
    assert.match(NIGHT_NOTES_BLOCK, /Most nights it does not/,
        "a model told to maintain notes every night rewrites them every night");
});

test("logging the day stays first", () => {
    assert.match(NIGHT_NOTES_BLOCK, /Logging today comes first/);
});

test("the tool it names exists and is always declared", () => {
    assert.match(NIGHT_NOTES_BLOCK, /updateNotes/);
    assert.ok(toolRegistry.isDeclared("updateNotes"), "a block naming an undeclared tool earns a refusal");
});

// ── wiring ───────────────────────────────────────────────────────────────────

const agentSrc = readFileSync("src/agent/agent.js", "utf8");

test("runAgent claims once per turn, for the bound user", () => {
    assert.match(agentSrc, /routineNudge\(openFlows, \{ userId \}\)/);
    assert.strictEqual((agentSrc.match(/routineNudge\(/g) || []).length, 1,
        "one call site: a second would claim twice in a turn");
});

test("the notes blocks sit before the routine's own overlay, not after it", () => {
    assert.match(agentSrc, /\[nudge, notesUpkeep\(openFlows\), \.\.\.routineOverlays\]/,
        "the routine's procedure and data stay last, where recency weighs most");
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
