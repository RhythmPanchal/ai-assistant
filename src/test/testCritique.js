/**
 * Hand-run:  node src/test/testCritique.js
 *
 * The nightly self-critique, end to end minus the model and the database.
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects — every assertion here is over pure functions.
 */
import "dotenv/config";
import assert from "node:assert";
import path from "node:path";
import { readFileSync } from "node:fs";

const tests = [];
const test = (n, f) => tests.push([n, f]);

const { pickCritiqueDay, reportPath, reportDir, CRITIQUE_HOUR } =
    await import("../scheduler/jobs/critiqueDayJob.js");
const { renderTurns } = await import("../knowledge/turnReviewKnowledge.js");
const { coerceCritique, buildCritiqueMessages, KINDS, SEVERITIES } =
    await import("../agent/critique/critiqueDay.js");
const { renderCritiqueReport, parseCritiqueCounts } =
    await import("../agent/critique/critiqueReport.js");

const IST = "Asia/Kolkata";

/* ───────────────────────────── which day ───────────────────────────── */

test("at 03:00 the day under review is the personal day that just ended", () => {
    // 2026-11-10T03:00 IST. With a 04:00 boundary the personal day in progress
    // is still the 9th, and it will not change again — so it is the finished
    // day, and taking previousDay as well would review the 8th twice.
    const at = new Date("2026-11-09T21:30:00.000Z");
    assert.strictEqual(pickCritiqueDay(at, { timeZone: IST, dayStartHour: 4 }), "2026-11-09");
});

test("moved past the day boundary it still picks a finished day, not a half-done one", () => {
    // The hour is configurable, so the pass must not assume it runs at 03:00.
    // At 10:00 the personal day in progress is today and most of it has yet to
    // happen; the finished day is the one before.
    const at = new Date("2026-11-10T04:30:00.000Z"); // 10:00 IST
    assert.strictEqual(pickCritiqueDay(at, { timeZone: IST, dayStartHour: 4 }), "2026-11-09");
});

test("a midnight day boundary still yields the day that ended", () => {
    const at = new Date("2026-11-09T21:30:00.000Z"); // 03:00 IST
    assert.strictEqual(pickCritiqueDay(at, { timeZone: IST, dayStartHour: 0 }), "2026-11-09");
});

test("the day is read in the user's zone, not the host's", () => {
    // 2026-11-10T02:00 IST is still 2026-11-09 in New York.
    const at = new Date("2026-11-09T20:30:00.000Z");
    const ist = pickCritiqueDay(at, { timeZone: IST, dayStartHour: 4 });
    const ny = pickCritiqueDay(at, { timeZone: "America/New_York", dayStartHour: 4 });
    assert.strictEqual(ist, "2026-11-09");
    assert.strictEqual(ny, "2026-11-08", "16:00 in NY is a day already finished there");
});

test("the pass runs before the day rolls over", () => {
    assert.ok(CRITIQUE_HOUR < 4, "a critique hour at or after dayStartHour reviews an unfinished day by default");
});

/* ──────────────────────── the report stays out of git ──────────────────────── */

test("reports land in a gitignored directory", () => {
    // A generated file per night inside a tracked path would leave git status
    // dirty every morning, against this project's start-clean rule.
    const root = path.resolve(new URL("../../", import.meta.url).pathname);
    const rel = path.relative(root, reportDir());
    const ignored = readFileSync(path.join(root, ".gitignore"), "utf8")
        .split("\n").map(l => l.trim()).filter(Boolean);
    const top = rel.split(path.sep)[0];
    assert.ok(ignored.includes(`${top}/`) || ignored.includes(top),
        `${top} is not in .gitignore — every night's report would dirty the tree`);
});

test("one report per user per day", () => {
    assert.notStrictEqual(reportPath(1, "2026-11-09"), reportPath(2, "2026-11-09"));
    assert.notStrictEqual(reportPath(1, "2026-11-09"), reportPath(1, "2026-11-10"));
    assert.match(reportPath(1, "2026-11-09"), /2026-11-09-user1\.md$/);
});

/* ───────────────────────────── the transcript ───────────────────────────── */

const day = (over = {}) => ({
    conversationId: "c1",
    createdAt: new Date("2026-11-09T07:00:00.000Z"), // 12:30 IST
    messages: [],
    ...over,
});

test("tool calls AND their results both reach the transcript", () => {
    // The whole reason this renderer exists. A hallucination is a gap between
    // the claim and the result, so dropping either side makes it invisible.
    const { transcript } = renderTurns([day({
        messages: [
            { role: "user", content: "log 50 for rickshaw" },
            { role: "assistant", functionCalls: [{ name: "createRecord", args: { collectionName: "expenseRegister" } }] },
            { role: "tool", toolName: "createRecord", result: { insertedId: "abc" } },
            { role: "assistant", content: "Logged ₹50 for the rickshaw." },
        ],
    })], { timeZone: IST });

    assert.match(transcript, /rasmalai -> createRecord\(/);
    assert.match(transcript, /createRecord returned: /);
    assert.match(transcript, /insertedId/);
    assert.match(transcript, /Logged ₹50/);
    assert.match(transcript, /^### T1  12:30 · telegram/m);
});

test("a job's trigger is labelled a trigger, never the user", () => {
    // A critic that reads the morning job's own instruction as something the
    // person said grades the reply against a request nobody made.
    const { transcript } = renderTurns([day({
        source: "goodMorningJob",
        messages: [
            { role: "user", content: "It is time for the morning planning routine" },
            { role: "assistant", content: "Morning! Here is today." },
        ],
    })], { timeZone: IST });

    assert.match(transcript, /trigger: It is time for the morning/);
    assert.ok(!/user: It is time/.test(transcript), "a job trigger must not be presented as the user");
    assert.match(transcript, /· morning routine/);
});

test("dates in a tool result are rendered in local time", () => {
    // 2026-11-09T18:30Z is IST midnight on the 10th. Serialised as UTC it reads
    // as the 9th, and the critic would flag a correctly dated row as the wrong
    // day — the exact confusion datesForModel exists to stop on the live path.
    const { transcript } = renderTurns([day({
        messages: [{ role: "tool", toolName: "fetchRecord", result: { date: new Date("2026-11-09T18:30:00.000Z") } }],
    })], { timeZone: IST });

    assert.match(transcript, /2026-11-10/);
    assert.ok(!/2026-11-09T18:30/.test(transcript), "a raw UTC timestamp leaked into the critic's input");
});

test("turn ids are sequential and returned alongside the text", () => {
    const { turns, turnCount } = renderTurns([day(), day({ conversationId: "c2" })], { timeZone: IST });
    assert.deepStrictEqual(turns.map(t => t.id), ["T1", "T2"]);
    assert.strictEqual(turnCount, 2);
    assert.strictEqual(turns[1].conversationId, "c2");
});

test("a day with no turns says so instead of rendering nothing", () => {
    const { transcript, turnCount } = renderTurns([], { timeZone: IST });
    assert.strictEqual(turnCount, 0);
    assert.match(transcript, /no conversation/);
});

/* ───────────────────────────── the coercer ───────────────────────────── */

const ids = { turnIds: ["T1", "T2"], transcript: "rasmalai: Logged your dinner and the fifty rupee rickshaw." };
const finding = (over = {}) => ({
    turn: "T1", kind: "hallucination", severity: "high",
    summary: "Claimed dinner was saved with no successful call.",
    evidence: "Logged your dinner and the fifty rupee rickshaw.",
    suggestion: "Forbid the claim before the tool returns.",
    ...over,
});

test("a sound finding survives intact and is marked verbatim", () => {
    const { findings } = coerceCritique({ findings: [finding()] }, ids);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].kind, "hallucination");
    assert.strictEqual(findings[0].quoted, true, "the quote is in the transcript and must be marked so");
});

test("a finding citing a turn that does not exist is dropped", () => {
    // The turn id is the only handle the fix session has on the evidence.
    const { findings, dropped } = coerceCritique({ findings: [finding({ turn: "T9" })] }, ids);
    assert.strictEqual(findings.length, 0);
    assert.match(dropped.join(" "), /unknown turn "T9"/);
});

test("a finding with no evidence is dropped, however confident it sounds", () => {
    // Evidence is the whole defence against a critic inventing work.
    for (const evidence of [undefined, "", "   ", "bad", "null"]) {
        const { findings } = coerceCritique({ findings: [finding({ evidence })] }, ids);
        assert.strictEqual(findings.length, 0, `evidence ${JSON.stringify(evidence)} should not pass`);
    }
});

test("an invented kind is dropped; an invented severity is defaulted", () => {
    const { findings: a } = coerceCritique({ findings: [finding({ kind: "vibes" })] }, ids);
    assert.strictEqual(a.length, 0, "an unknown kind would sort to the bottom of the report silently");

    const { findings: b } = coerceCritique({ findings: [finding({ severity: "critical" })] }, ids);
    assert.strictEqual(b.length, 1, "severity is a label, not a fact — do not lose the finding over it");
    assert.strictEqual(b[0].severity, "medium");
});

test("a paraphrased quote is kept but flagged", () => {
    const { findings } = coerceCritique(
        { findings: [finding({ evidence: "It said the dinner had been written down." })] }, ids);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].quoted, false);
});

test("worst first: severity, then wrong claims over missed chances", () => {
    const { findings } = coerceCritique({
        findings: [
            finding({ turn: "T2", kind: "improvement", severity: "low" }),
            finding({ turn: "T2", kind: "bug", severity: "high" }),
            finding({ turn: "T1", kind: "hallucination", severity: "high" }),
            finding({ turn: "T1", kind: "improvement", severity: "medium" }),
        ],
    }, ids);
    assert.deepStrictEqual(
        findings.map(f => `${f.severity}:${f.kind}`),
        ["high:hallucination", "high:bug", "medium:improvement", "low:improvement"]
    );
});

test("a quiet night is a valid answer, not an empty object", () => {
    const c = coerceCritique({ satisfaction: { score: 5, why: "nothing to fault" }, findings: [] }, ids);
    assert.deepStrictEqual(c.findings, []);
    assert.strictEqual(c.satisfaction.score, 5);
});

test("too little to judge scores null, never a middling 3", () => {
    for (const score of [undefined, null, "lots", 9, 0]) {
        const c = coerceCritique({ satisfaction: { score, why: "x" }, findings: [] }, ids);
        assert.strictEqual(c.satisfaction.score, null, `${score} must not become a number`);
        assert.strictEqual(c.satisfaction.why, null, "a why with no score is evidence for nothing");
    }
    assert.strictEqual(coerceCritique({ satisfaction: { score: "4/5" } }, ids).satisfaction.score, 4);
});

test("findings are capped so the report stays a work list", () => {
    const many = Array.from({ length: 30 }, () => finding());
    assert.ok(coerceCritique({ findings: many }, ids).findings.length <= 12);
});

test("a reply with nothing usable in it coerces to an empty critique", () => {
    for (const parsed of [null, {}, { findings: "nope" }, { findings: [null, 3] }]) {
        const c = coerceCritique(parsed, ids);
        assert.deepStrictEqual(c.findings, []);
        assert.strictEqual(c.satisfaction.score, null);
    }
});

/* ───────────────────────────── the report file ───────────────────────────── */

const critiqueOf = (findings, over = {}) => ({
    satisfaction: { score: 3, why: "one real miss" }, findings, wentWell: [], dropped: [], ...over,
});
const turnsOf = [{ id: "T1", source: "telegram", at: new Date("2026-11-09T07:00:00.000Z") }];

test("the footer is machine-readable and round-trips", () => {
    // It is what a scheduled fix session greps to decide whether there is work,
    // without re-reasoning over the prose.
    const { findings } = coerceCritique({ findings: [finding(), finding({ turn: "T2", severity: "low", kind: "improvement" })] }, ids);
    const md = renderCritiqueReport({ userId: 1, logDate: "2026-11-09", critique: critiqueOf(findings), turns: turnsOf });

    const counts = parseCritiqueCounts(md);
    assert.deepStrictEqual(counts, { date: "2026-11-09", user: 1, findings: 2, high: 1, medium: 0, low: 1 });
});

test("a report with no findings says so and reports zero", () => {
    const md = renderCritiqueReport({ userId: 1, logDate: "2026-11-09", critique: critiqueOf([]), turns: turnsOf });
    assert.match(md, /had nothing to report/);
    assert.strictEqual(parseCritiqueCounts(md).findings, 0);
});

test("an unverbatim quote carries its warning into the file", () => {
    const { findings } = coerceCritique({ findings: [finding({ evidence: "It claimed the dinner was written down." })] }, ids);
    const md = renderCritiqueReport({ userId: 1, logDate: "2026-11-09", critique: critiqueOf(findings), turns: turnsOf });
    assert.match(md, /not found verbatim/);
});

test("the report names the turn and the critic model", () => {
    const { findings } = coerceCritique({ findings: [finding()] }, ids);
    const md = renderCritiqueReport({
        userId: 1, logDate: "2026-11-09", critique: critiqueOf(findings),
        turns: turnsOf, model: "anthropic:claude-haiku-5-5",
    });
    assert.match(md, /· T1/);
    assert.match(md, /anthropic:claude-haiku-5-5/);
    assert.match(md, /\| T1 \| 12:30 \| telegram \|/);
});

test("findings dropped by the coercer are recorded in the file", () => {
    // A critic that keeps citing turns that do not exist is itself the finding,
    // and nothing else would surface it.
    const c = coerceCritique({ findings: [finding({ turn: "T9" })] }, ids);
    const md = renderCritiqueReport({ userId: 1, logDate: "2026-11-09", critique: c, turns: turnsOf });
    assert.match(md, /Discarded by the coercer/);
    assert.match(md, /unknown turn/);
});

/* ───────────────────────────── the wiring ───────────────────────────── */

test("the critique is opt-in and off by default", () => {
    const { critiqueDue } = require_initCron();
    assert.strictEqual(critiqueDue({ preferences: {} }, 3), false, "nobody is audited without asking");
    assert.strictEqual(critiqueDue(null, 3), false);
    assert.strictEqual(critiqueDue({ preferences: { agentCritique: true } }, 3), true);
    assert.strictEqual(critiqueDue({ preferences: { agentCritique: true } }, 4), false);
    assert.strictEqual(critiqueDue({ preferences: { agentCritique: true, critiqueHour: 2 } }, 2), true);
    assert.strictEqual(critiqueDue({ preferences: { agentCritique: true, critiqueHour: 2 } }, 3), false);
    assert.strictEqual(critiqueDue({ preferences: { triggersOptIn: true } }, 3), false,
        "wanting a good-morning message is not consenting to an audit");
});

test("routineDue is untouched — the critique is not a user-facing routine", () => {
    const { routineDue, ROUTINE_HOURS } = require_initCron();
    assert.deepStrictEqual(ROUTINE_HOURS, { morning: 9, night: 23 });
    assert.strictEqual(routineDue({ preferences: { agentCritique: true } }, 3), null);
});

test("the job is dispatchable with its params in signature order", async () => {
    const { ACTION_MAP } = await import("../scheduler/actionDispatcher.js");
    assert.ok(ACTION_MAP.critiqueDayJob, "a missed night cannot be re-run as a one-off row");
    assert.deepStrictEqual(ACTION_MAP.critiqueDayJob.params, ["userId", "logDate", "timeZone"]);
});

test("the critique has its own model chain and no last-resort entry", async () => {
    const { agentConfig } = await import("../config/agent.config.js");
    const chain = agentConfig.llm.tasks.critique?.chain;
    assert.ok(Array.isArray(chain) && chain.length, "no chain means the pass falls back to `conversation`");
    // A day left uncritiqued costs nothing; a bad critique becomes a code change.
    assert.ok(!chain.some(e => e.model.includes(":free")),
        "a free last-resort model must not be allowed to judge the other chains");
});

test("the critic is never offered to the model as a tool", async () => {
    const registry = (await import("../agent/tools/definitions/index.js")).default;
    const names = registry.getToolDeclarations().map(d => d.name);
    for (const banned of ["critiqueDayJob", "critiqueDay"]) {
        assert.ok(!names.includes(banned), `${banned} must not be callable by the agent it audits`);
    }
});

/* ───────────────────────────── the prompt ───────────────────────────── */

test("the instruction defines the three hallucination tests, and permits silence", async () => {
    const { TURN_CRITIQUE_INSTRUCTION } = await import("../agent/critique/critiquePrompt.js");
    // The padding reflex is the pass's main failure mode: a critic asked what
    // went wrong will find something, and the fix session then edits a working
    // prompt. The permission to return nothing has to be explicit.
    assert.match(TURN_CRITIQUE_INSTRUCTION, /empty findings list/);
    assert.match(TURN_CRITIQUE_INSTRUCTION, /Do not pad/);
    assert.match(TURN_CRITIQUE_INSTRUCTION, /no successful tool call/);
    assert.match(TURN_CRITIQUE_INSTRUCTION, /appears in no tool result/);
    assert.match(TURN_CRITIQUE_INSTRUCTION, /not a finding/i);
    for (const kind of KINDS) assert.ok(TURN_CRITIQUE_INSTRUCTION.includes(kind));
    for (const sev of SEVERITIES) assert.ok(TURN_CRITIQUE_INSTRUCTION.includes(sev));
});

test("the transcript is the last thing the critic reads", () => {
    const [system, user] = buildCritiqueMessages({
        logDate: "2026-11-09", transcript: "### T1\nuser: hi", turnCount: 1, timeZone: IST,
    });
    assert.strictEqual(system.role, "system");
    assert.match(user.content, /Monday 2026-11-09/);
    assert.match(user.content, /END TRANSCRIPT ---$/);
});

let initCronMod;
function require_initCron() {
    return initCronMod;
}

initCronMod = await import("../scheduler/initCron.js");

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
