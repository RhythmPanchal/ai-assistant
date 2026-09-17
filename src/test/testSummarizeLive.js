/**
 * Hand-run:
 *   node src/test/testSummarizeLive.js --dry          build both prompts, call nothing
 *   node src/test/testSummarizeLive.js                fixture day -> real LLM calls
 *   node src/test/testSummarizeLive.js --from-db 1 2026-09-03
 *   node src/test/testSummarizeLive.js --from-db 1 2026-09-03 --write
 *
 * What the summary job actually sends and what actually comes back: the review
 * (plan vs logged work, and the day's scores), then the summary it feeds. --dry
 * needs no network and no key; the default needs a key but writes nothing;
 * --write is the only mode that touches chatSummary.
 *
 * The fixture is the two cases the summary exists for: a health state that must
 * survive to tomorrow's schedule, and a passing detail nobody would think to
 * record — on a day whose locked-in plan did not survive the morning.
 */
import "dotenv/config";
import { buildMessages } from "../agent/summarize/summarizeDay.js";
import { buildReviewMessages } from "../agent/summarize/reviewDay.js";
import { buildDayRecord } from "../agent/summarize/dayRecord.js";
import { workBlocksOf, workItemsOf } from "../agent/summarize/planComparison.js";
import { previousDay } from "../tools/mongo/dateUtils.js";
import ValidateSchema from "../tools/mongo/validateSchema.js";
import { CHAT_SUMMARY } from "../tools/mongo/schema/chatSummarySchema.js";
import { renderRecentBlock } from "../knowledge/chatSummaryKnowledge.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const fromDb = args.indexOf("--from-db");

const LOG_DATE = "2026-09-03";

const FIXTURE_TRANSCRIPT = `
[08:30] user: not feeling great today, slight fever since morning
[08:31] rasmalai: Noted. Want me to keep today light?
[08:32] user: ya keep it light, i'll try to work half day
[09:00] rasmalai (morning routine): Here's a light day given the fever:
  09:30-11:00  Q3 deck - review Ankit's comments
  11:00-11:30  break
  11:30-13:00  Standup + inbox
  Afternoon kept free. Skipping the gym block today.
[09:05] user: ok fine
[14:20] user: fever went up, going to the hospital now
[14:21] rasmalai: Go. I'll hold everything. Tell me when you're out.
[19:40] user: they admitted me, keeping me overnight for observation. blood tests done, reports tomorrow
[19:41] rasmalai: Understood. Nothing on your plate until you say otherwise.
[19:42] user: told ankit the deck review has to move to monday
[21:15] user: watching loki in the hospital bed lol, actually pretty good
[23:00] rasmalai (night routine): Before we wrap up the day, give me a quick update - how was your day, what did you complete, what did you eat, what did you spend?
[23:14] user: barely ate, just hospital khichdi for dinner. spent 800 on the cab and admission stuff. didn't finish anything on the deck, only cleared some inbox in the morning, maybe 40 mins
[23:15] rasmalai (night routine): Logged: 1 meal (Dinner, khichdi), Rs 800 on Health, 40 min of inbox.
[23:16] user: ya that's it, gn
`.trim();

const FIXTURE_PREVIOUS = {
    date: new Date(`${previousDay(LOG_DATE)}T00:00:00+05:30`),
    headline: "Normal work day, drafted the Q3 deck and sent it to Ankit for review.",
    state: ["Q3 deck review with Ankit due Fri 4th", "Renewed the gym membership on Mon"],
    openThreads: ["Waiting on Ankit's comments on the Q3 deck"],
};

const FIXTURE_SCHEDULE = {
    slots: [
        { slotId: "slot_1", startTime: "09:30", endTime: "11:00", title: "Q3 deck - review Ankit's comments", category: "Work", status: "Planned", taskRef: null },
        { slotId: "slot_2", startTime: "11:00", endTime: "11:30", title: "Break", category: "Routine", status: "Planned", taskRef: null },
        { slotId: "slot_3", startTime: "11:30", endTime: "13:00", title: "Standup + inbox", category: "Work", status: "Planned", taskRef: null },
    ],
};

const FIXTURE_TASK_LOGS = [{
    performedTasks: [{ title: "cleared some inbox", actualDurationMinutes: 40, status: "Completed", taskId: null, category: "Work" }],
}];

async function loadFromDb(userId, date) {
    const { default: dayTranscriptKnowledge } = await import("../knowledge/dayTranscriptKnowledge.js");
    const { findDaySummary } = await import("../tools/mongo/operation/chatSummaries.js");
    const { runAsSystem } = await import("../identity/userContext.js");
    const { getDB } = await import("../tools/mongo/mongoClient.js");
    const { localDayRange } = await import("../tools/mongo/dateUtils.js");

    const { start, end } = localDayRange(date);
    const day = { userId, date: { $gte: start, $lt: end } };
    const db = await getDB();

    return runAsSystem("testSummarizeLive", async () => ({
        transcript: await dayTranscriptKnowledge(userId, date),
        previous: await findDaySummary(userId, previousDay(date)),
        schedule: await db.collection("userSchedule").find(day).sort({ _id: -1 }).limit(1).next(),
        taskLogs: await db.collection("taskRegister").find(day).toArray(),
    }));
}

const rule = (t) => console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);
const charsOf = (messages) => messages.reduce((n, m) => n + m.content.length, 0);

let userId = 1;
let logDate = LOG_DATE;
let transcript = FIXTURE_TRANSCRIPT;
let previous = FIXTURE_PREVIOUS;
let schedule = FIXTURE_SCHEDULE;
let taskLogs = FIXTURE_TASK_LOGS;

if (fromDb !== -1) {
    userId = Number(args[fromDb + 1]);
    logDate = args[fromDb + 2];
    if (!Number.isInteger(userId) || !logDate) {
        console.error("usage: --from-db <userId> <YYYY-MM-DD>");
        process.exit(1);
    }
    console.log(`Reading ${logDate} for user ${userId} from the database…`);
    ({ transcript, previous, schedule, taskLogs } = await loadFromDb(userId, logDate));
    console.log(`  transcript: ${transcript.length} chars`);
    console.log(`  previous row: ${previous ? previous.headline : "none"}`);
    console.log(`  schedule: ${schedule ? `${schedule.slots?.length ?? 0} slots` : "none"}`);
    console.log(`  task log: ${taskLogs.flatMap(t => t.performedTasks ?? []).length} entries`);
}

// ------------------------------------------------------------------ dry run --
// The summary's own prompt depends on the review's answer, so the dry run shows
// it as it is sent when the review is not yet in.
const blocks = workBlocksOf(schedule);
const work = workItemsOf(taskLogs);
const reviewMessages = buildReviewMessages({ logDate, transcript, blocks, work });
const summaryMessages = buildMessages({ logDate, transcript, previous });

rule("WHAT IS SENT");
console.log(`review:  2 messages, ${charsOf(reviewMessages)} chars (~${Math.ceil(charsOf(reviewMessages) / 4)} tokens), 0 tools`);
console.log(`summary: 2 messages, ${charsOf(summaryMessages)} chars (~${Math.ceil(charsOf(summaryMessages) / 4)} tokens) before the comparison, 0 tools`);
console.log("\nNo chat history. No tool declarations. No profile block.");

if (has("--dry")) {
    rule("REVIEW — SYSTEM MESSAGE");
    console.log(reviewMessages[0].content);
    rule("REVIEW — USER MESSAGE");
    console.log(reviewMessages[1].content);
    rule("SUMMARY — SYSTEM MESSAGE");
    console.log(summaryMessages[0].content);
    rule("SUMMARY — USER MESSAGE");
    console.log(summaryMessages[1].content);
    console.log("\n--dry: nothing was called.\n");
    process.exit(0);
}

// ---------------------------------------------------------------- live calls --
rule("CALLING THE MODELS");
const { row, review, models } = await buildDayRecord({ userId, logDate, transcript, previous, schedule, taskLogs });

rule(`THE REVIEW  (${models.review})`);
console.log(JSON.stringify(review, null, 2));

rule(`THE ROW WE WOULD STORE  (summary ${models.summary})`);
console.log(JSON.stringify(row, null, 2));

// The row is built here, not by the model — so this asserts our coercion, and
// catches a schema drift between chatSummarySchema and what the job emits.
try {
    await ValidateSchema(CHAT_SUMMARY, row);
    console.log("\n✓ validates against chatSummarySchema");
} catch (e) {
    console.error(`\n✗ FAILS validation: ${e.message}`);
    process.exit(1);
}

rule("HOW IT READS IN TOMORROW'S PROMPT");
const tomorrow = new Date(new Date(`${logDate}T12:00:00+05:30`).getTime() + 86400000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const block = renderRecentBlock([row], { today: tomorrow });
console.log(block);
console.log(`\n(${block.length} chars, ~${Math.ceil(block.length / 4)} tokens)`);

// ------------------------------------------------------------------- writing --
if (has("--write")) {
    const { createRecord } = await import("../tools/mongo/createRecord.js");
    const { runWithUserContext } = await import("../identity/userContext.js");
    const res = await runWithUserContext(
        { userId, channel: "system", reason: "testSummarizeLive" },
        () => createRecord(CHAT_SUMMARY, row)
    );
    console.log(`\n✓ written: ${res.insertedId}`);
} else {
    console.log("\n(nothing written — pass --write to store it)");
}
console.log();
process.exit(0);
