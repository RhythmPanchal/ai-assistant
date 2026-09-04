/**
 * Hand-run:
 *   node src/test/testSummarizeLive.js --dry          build the prompt, call nothing
 *   node src/test/testSummarizeLive.js                fixture day -> real LLM call
 *   node src/test/testSummarizeLive.js --from-db 1 2026-09-03
 *   node src/test/testSummarizeLive.js --from-db 1 2026-09-03 --write
 *
 * What the pass actually sends and what actually comes back. --dry needs no
 * network and no key; the default needs a key but writes nothing; --write is
 * the only mode that touches chatSummary.
 *
 * The fixture is the two cases this whole feature exists for: a health state
 * that must survive to tomorrow's schedule, and a passing detail nobody would
 * think to record.
 */
import "dotenv/config";
import { buildMessages, summarizeDay, extractJson, coerceRow } from "../agent/summarize/summarizeDay.js";
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
[09:05] user (replying to the morning routine): ok fine
[14:20] user: fever went up, going to the hospital now
[14:21] rasmalai: Go. I'll hold everything. Tell me when you're out.
[19:40] user: they admitted me, keeping me overnight for observation. blood tests done, reports tomorrow
[19:41] rasmalai: Understood. Nothing on your plate until you say otherwise.
[19:42] user: told ankit the deck review has to move to monday
[21:15] user: watching loki in the hospital bed lol, actually pretty good
[23:00] rasmalai (night routine): Before we wrap up the day, give me a quick update - how was your day, what did you complete, what did you eat, what did you spend?
[23:14] user (replying to the night routine): barely ate, just hospital khichdi for dinner. spent 800 on the cab and admission stuff. didn't finish anything on the deck
[23:15] rasmalai (night routine): Logged: 1 meal (Dinner, khichdi), Rs 800 on Health. Nothing on tasks.
[23:16] user (replying to the night routine): ya that's it, gn
`.trim();

const FIXTURE_PREVIOUS = {
    date: new Date(`${previousDay(LOG_DATE)}T00:00:00+05:30`),
    headline: "Normal work day, drafted the Q3 deck and sent it to Ankit for review.",
    state: ["Q3 deck review with Ankit due Fri 4th", "Renewed the gym membership on Mon"],
    openThreads: ["Waiting on Ankit's comments on the Q3 deck"],
};

async function loadFromDb(userId, date) {
    const { default: dayTranscriptKnowledge } = await import("../knowledge/dayTranscriptKnowledge.js");
    const { findDaySummary } = await import("../tools/mongo/operation/chatSummaries.js");
    const { runAsSystem } = await import("../identity/userContext.js");
    return runAsSystem("testSummarizeLive", async () => ({
        transcript: await dayTranscriptKnowledge(userId, date),
        previous: await findDaySummary(userId, previousDay(date)),
    }));
}

const rule = (t) => console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);

let userId = 1;
let logDate = LOG_DATE;
let transcript = FIXTURE_TRANSCRIPT;
let previous = FIXTURE_PREVIOUS;

if (fromDb !== -1) {
    userId = Number(args[fromDb + 1]);
    logDate = args[fromDb + 2];
    if (!Number.isInteger(userId) || !logDate) {
        console.error("usage: --from-db <userId> <YYYY-MM-DD>");
        process.exit(1);
    }
    console.log(`Reading ${logDate} for user ${userId} from the database…`);
    ({ transcript, previous } = await loadFromDb(userId, logDate));
    console.log(`  transcript: ${transcript.length} chars`);
    console.log(`  previous row: ${previous ? previous.headline : "none"}`);
}

// ------------------------------------------------------------------ dry run --
const messages = buildMessages({ logDate, transcript, previous });
const totalChars = messages.reduce((n, m) => n + m.content.length, 0);

rule("WHAT IS SENT");
console.log(`2 messages, ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens), 0 tools`);
console.log(`  system: ${messages[0].content.length} chars — the instruction`);
console.log(`  user:   ${messages[1].content.length} chars — the day`);
console.log("\nNo chat history. No tool declarations. No profile block.");

if (has("--dry")) {
    rule("SYSTEM MESSAGE");
    console.log(messages[0].content);
    rule("USER MESSAGE");
    console.log(messages[1].content);
    console.log("\n--dry: nothing was called.\n");
    process.exit(0);
}

// ----------------------------------------------------------------- live call --
rule("CALLING THE MODEL");
const { row, raw, provider, model } = await summarizeDay({ userId, logDate, transcript, previous });

rule(`RAW REPLY  (${provider}:${model})`);
console.log(raw);

rule("THE ROW WE WOULD STORE");
console.log(JSON.stringify(row, null, 2));

// The row is built here, not by the model — so this asserts our coercion, and
// catches a schema drift between chatSummarySchema and what coerceRow emits.
try {
    await ValidateSchema(CHAT_SUMMARY, row);
    console.log("\n✓ validates against chatSummarySchema");
} catch (e) {
    console.error(`\n✗ FAILS validation: ${e.message}`);
    process.exit(1);
}

rule("HOW IT READS IN TOMORROW'S PROMPT");
const block = renderRecentBlock([row], { today: "2026-09-04" });
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
