/**
 * Hand-run:  node src/test/testDayRecord.js
 *
 * Guards how a day's row is put together from its two model calls — the review
 * and the summary — with both calls scripted, so no model is reached.
 *
 * What it pins: the review runs first and the summary is handed its comparison;
 * every number comes from code even when the model sends one; an unusable
 * review costs the scores and not the row; a call that fails writes nothing.
 *
 * It also runs summarizeDayJob over seeded rows. That, and the usage meter's
 * llmUsage rollup, write to the database — so this points at Rasmalai-eval and
 * removes everything filed under its user before and after.
 */
import "dotenv/config";

process.env.MONGODB_DB_NAME = "Rasmalai-eval";

const { buildDayRecord } = await import("../agent/summarize/dayRecord.js");
const { ProviderManager } = await import("../agent/llm/createProvider.js");
const { LLMResponse } = await import("../agent/llm/BaseLLMProvider.js");
const { DAY_REVIEW_INSTRUCTION } = await import("../agent/summarize/reviewPrompt.js");
const { DAY_SUMMARY_INSTRUCTION } = await import("../agent/summarize/dayPrompt.js");
const { VERDICTS } = await import("../agent/summarize/planComparison.js");
const { CHAT_SUMMARY } = await import("../tools/mongo/schema/chatSummarySchema.js");
const { default: ValidateSchema } = await import("../tools/mongo/validateSchema.js");
const { getDB } = await import("../tools/mongo/mongoClient.js");
const { summarizeDayJob } = await import("../scheduler/jobs/summarizeDayJob.js");
const { runWithUserContext } = await import("../identity/userContext.js");
const { localDayRange } = await import("../tools/mongo/dateUtils.js");

const USER = 900070;
const db = await getDB();
if (/prod/i.test(db.databaseName)) throw new Error(`refusing to write to ${db.databaseName}`);

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => cond ? passed++ : failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);

const realChat = ProviderManager.prototype.chatWithFallback;

/** Answer the review and the summary with what each script says. */
function scriptCalls({ review, summary }) {
    const calls = [];
    ProviderManager.prototype.chatWithFallback = async function (messages, tools) {
        const which = messages[0].content === DAY_REVIEW_INSTRUCTION ? "review"
            : messages[0].content === DAY_SUMMARY_INSTRUCTION ? "summary" : "unknown";
        calls.push({ which, input: messages[1].content, tools });
        const reply = which === "review" ? review : summary;
        if (reply instanceof Error) throw reply;
        const res = new LLMResponse({ text: typeof reply === "string" ? reply : JSON.stringify(reply) });
        res.provider = "stub";
        res.model = which;
        return res;
    };
    return calls;
}

const SCHEDULE = {
    slots: [
        { slotId: "slot_1", startTime: "10:00", endTime: "13:00", title: "Q3 deck review", category: "Work", status: "Planned", taskRef: null },
        { slotId: "slot_2", startTime: "13:00", endTime: "14:00", title: "Lunch", category: "Routine", status: "Planned", taskRef: null },
        { slotId: "slot_3", startTime: "18:00", endTime: "19:00", title: "Gym", category: "Health", status: "Planned", taskRef: null },
    ],
};
const TASK_LOGS = [{
    performedTasks: [
        { title: "Prod outage firefight", actualDurationMinutes: 300, status: "Completed", taskId: null },
        { title: "Gym session", actualDurationMinutes: 60, status: "Completed", taskId: null },
    ],
}];
const SUMMARY = {
    headline: "A prod outage took the whole working day; made it to the gym in the evening.",
    state: [], openThreads: [], mentioned: [],
    followThrough: "Planned the deck review and the gym; the outage replaced the deck review, gym done.",
    mood: "anxious in the morning, relieved by the evening",
};
const REVIEW = {
    matches: [
        { block: "b1", work: [], outcome: "not done" },
        { block: "b2", work: ["w2"], outcome: "done" },
    ],
    productivity: { score: 4, why: "five hours fixing the outage" },
    mood: { score: 3, why: "stressed until the fix, relieved after" },
    health: { score: 4, why: "went to the gym" },
    overall: { score: 3, why: "hard day that ended well" },
    // A model that does its own sums. Nothing below may come from here.
    plannedMinutes: 999, verdict: "followed the plan", followedPct: 100,
};

const day = (overrides = {}) => buildDayRecord({
    userId: USER,
    logDate: "2026-09-17",
    transcript: "[10:05] user: prod is down\n[23:10] user: fixed it finally, gym done too",
    schedule: SCHEDULE,
    taskLogs: TASK_LOGS,
    ...overrides,
});

try {
    // ---------------------------------------------------------- the normal day --
    {
        const calls = scriptCalls({ review: REVIEW, summary: SUMMARY });
        const { row, models } = await day();

        ok("two calls, the review first", calls.map(c => c.which).join(",") === "review,summary", calls.map(c => c.which).join(","));
        ok("neither call is offered tools", calls.every(c => Array.isArray(c.tools) && c.tools.length === 0));
        ok("the review is shown the plan without its furniture", calls[0].input.includes("b2  18:00-19:00  Gym") && !calls[0].input.includes("Lunch"), calls[0].input);
        ok("the summary is handed the comparison the review's matches produced",
            calls[1].input.includes("PLAN VS LOGGED WORK") && calls[1].input.includes(`Verdict: ${VERDICTS.DIFFERENT}`), calls[1].input);

        ok("the summary's fields are the row's", row.headline === SUMMARY.headline && row.mood === SUMMARY.mood);
        ok("productivity carries the review's score and evidence", row.productivity.score === 4 && row.productivity.why === "five hours fixing the outage");
        ok("the planned minutes are counted, not taken from the model", row.productivity.plannedMinutes === 240, row.productivity.plannedMinutes);
        ok("the verdict is decided in code", row.productivity.verdict === VERDICTS.DIFFERENT, row.productivity.verdict);
        ok("the percentage is computed", row.productivity.followedPct === 25, row.productivity.followedPct);
        ok("the review's match is applied", row.productivity.blocks[1].work[0] === "Gym session");
        ok("unplanned work is listed", row.productivity.unplanned[0]?.title === "Prod outage firefight");
        ok("the other three scores are the row's ratings",
            row.ratings.mood.score === 3 && row.ratings.health.score === 4 && row.ratings.overall.score === 3);
        ok("both models are reported", models.review === "stub:review" && models.summary === "stub:summary");

        let error = null;
        try { await ValidateSchema(CHAT_SUMMARY, row); } catch (e) { error = e.message; }
        ok("the row passes the schema", !error, error);
    }

    // ------------------------------------------------------ an unusable review --
    {
        const calls = scriptCalls({ review: "Sorry, I can't rate this day.", summary: SUMMARY });
        const { row } = await day();
        ok("a review that is not JSON does not stop the summary", calls.length === 2 && row.headline === SUMMARY.headline);
        ok("its scores are empty rather than invented", row.productivity.score === null && row.ratings.overall.score === null);
        ok("the numbers are still counted from the rows", row.productivity.plannedMinutes === 240 && row.productivity.loggedMinutes === 360);
        ok("with no matches nothing is claimed as followed", row.productivity.followedMinutes === 0);
    }

    // ------------------------------------------------------------ no schedule --
    {
        scriptCalls({ review: { ...REVIEW, matches: [] }, summary: SUMMARY });
        const { row } = await day({ schedule: null });
        ok("a day with no schedule is 'no plan'", row.productivity.verdict === VERDICTS.NO_PLAN);
        ok("and all its work is unplanned", row.productivity.unplannedMinutes === 360);
    }

    // --------------------------------------------------------- a call that fails --
    {
        const calls = scriptCalls({ review: new Error("503 all models busy"), summary: SUMMARY });
        let thrown = null;
        try { await day(); } catch (e) { thrown = e.message; }
        ok("a review that reaches no model throws, so the job retries the day", /503/.test(thrown ?? ""), thrown);
        ok("and the summary is not attempted", calls.length === 1);
    }
    {
        scriptCalls({ review: REVIEW, summary: new Error("429 quota") });
        let thrown = null;
        try { await day(); } catch (e) { thrown = e.message; }
        ok("a summary that reaches no model throws too", /429/.test(thrown ?? ""), thrown);
    }

    // ------------------------------------------------------------ the job --
    // The day's rows as the routines leave them, then the job the scheduler runs.
    {
        await cleanup();
        const { start } = localDayRange("2026-09-17");
        await db.collection("chatHistory").insertOne({
            conversationId: "test-day-record", userId: USER, source: "telegram",
            messages: [
                { role: "user", content: "fixed the outage finally, gym done too", timestamp: new Date("2026-09-17T17:40:00Z") },
                { role: "assistant", content: "Big day. Rest well.", timestamp: new Date("2026-09-17T17:40:05Z") },
            ],
            createdAt: new Date("2026-09-17T17:40:00Z"),
        });
        await db.collection("userSchedule").insertOne({ userId: USER, date: start, day: "Thursday", ...SCHEDULE, createdAt: new Date() });
        await db.collection("taskRegister").insertOne({ userId: USER, date: start, day: "Thursday", ...TASK_LOGS[0], createdAt: new Date() });

        const calls = scriptCalls({ review: REVIEW, summary: SUMMARY });
        const run = () => runWithUserContext({ userId: USER, channel: "scheduler", reason: "testDayRecord" },
            () => summarizeDayJob(USER, "2026-09-17", "Asia/Kolkata"));
        const result = await run();

        ok("the job reads the day's schedule for the review", calls[0]?.input.includes("Q3 deck review"), calls[0]?.input);
        ok("the job reads the day's task log for the review", calls[0]?.input.includes("w1  Prod outage firefight  (5h)"));
        ok("the job reads the day's chat for both calls", calls.length === 2 && calls.every(c => c.input.includes("fixed the outage finally")));

        const stored = await db.collection("chatSummary").findOne({ userId: USER, period: "day" });
        ok("one row is stored", Boolean(stored) && String(stored._id) === String(result.insertedId));
        ok("it carries the measured productivity", stored?.productivity?.verdict === VERDICTS.DIFFERENT && stored.productivity.plannedMinutes === 240,
            JSON.stringify(stored?.productivity));
        ok("it carries the ratings", stored?.ratings?.overall?.score === 3);
        ok("the numbers are stored as integers", Number.isInteger(stored?.productivity?.followedPct));

        const again = await run();
        ok("a second run for the same day is skipped without a model call", again.skipped === true && calls.length === 2);
    }
} finally {
    ProviderManager.prototype.chatWithFallback = realChat;
    await cleanup();
}

async function cleanup() {
    await Promise.all(["llmUsage", "chatSummary", "chatHistory", "userSchedule", "taskRegister"]
        .map(c => db.collection(c).deleteMany({ userId: USER })));
}

if (failures.length) {
    console.log(`✗ ${failures.length} failed, ${passed} passed\n`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`✓ testDayRecord: ${passed} passed`);
process.exit(0);
