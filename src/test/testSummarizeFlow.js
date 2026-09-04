/**
 * Hand-run:  node src/test/testSummarizeFlow.js
 *
 * Guards the day-summary pass. No .env, no network, no DB — every assertion is
 * against pure functions, static registries, or the validator.
 *
 * The two that matter most are the ones that fail silently in production:
 * a headline eaten by normalizeDates (Date.parse takes far more than it looks
 * like it does), and the summarize overlay leaking onto a real user's turn.
 */
import assert from "node:assert";

import { selectFlows, flowStateBlock } from "../agent/agent.js";
import summarizeFlow from "../agent/flows/summarizeFlow.js";
import goodMorningFlow from "../agent/flows/goodMorningFlow.js";
import goodNightFlow from "../agent/flows/goodNightFlow.js";
import { ACTION_MAP } from "../scheduler/actionDispatcher.js";
import { summarizeDayJob } from "../scheduler/jobs/summarizeDayJob.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { CHAT_SUMMARY, CHAT_SUMMARY_INDEXES } from "../tools/mongo/schema/chatSummarySchema.js";
import ValidateSchema, { normalizeDates } from "../tools/mongo/validateSchema.js";
import { ConversationBuilder } from "../tools/mongo/schema/chatHistorySchema.js";
import { localDayRange } from "../tools/mongo/dateUtils.js";

let passed = 0;
const failures = [];

function ok(name, condition, detail = "") {
    if (condition) passed++;
    else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

async function throws(name, fn, matcher) {
    try {
        await fn();
        failures.push(`${name}\n     expected a throw, got none`);
    } catch (e) {
        if (matcher && !matcher.test(e.message)) {
            failures.push(`${name}\n     message did not match ${matcher}\n     got: ${e.message}`);
        } else passed++;
    }
}

const night = { flowType: goodNightFlow.flowType, startedAt: new Date() };
const morning = { flowType: goodMorningFlow.flowType, startedAt: new Date() };
const summarize = { flowType: summarizeFlow.flowType, startedAt: new Date(), scratchpad: { logDate: "2026-09-04" } };

// ------------------------------------------------------- overlay isolation --
// The no-reply path fires two minutes after the morning routine opens, so these
// two flows really are open together. Without exclusivity the summarizer is
// handed the morning procedure and plans the user's day instead of writing a
// row — and it would do it silently, because both are valid agent turns.
ok("summarize pass sees only its own overlay",
    JSON.stringify(selectFlows([morning, summarize], "summarizeJob")) === JSON.stringify([summarize]));

// The other direction. A crashed pass leaves the flow open for 20 minutes; a
// user messaging inside that window must get the normal agent, not a job's
// private instructions telling it nobody is reading.
ok("a user's turn never sees the summarize overlay",
    JSON.stringify(selectFlows([morning, summarize], "telegram")) === JSON.stringify([morning]));

ok("ordinary flows are untouched",
    JSON.stringify(selectFlows([night, morning], "telegram")) === JSON.stringify([night, morning]));

ok("summarize wins task precedence over a still-open routine",
    selectFlows([morning, summarize], "summarizeJob")[0].flowType === "summarize");

// ------------------------------------------------------------- the log date --
// The whole reason the pass takes a seeded date. It runs after the day it
// covers: late that night on the reply path, 09:00 the next morning on the
// no-reply path. Deriving the day from startedAt files every no-reply summary
// one day late, against a row that already exists for that date.
ok("LOG DATE comes from the scratchpad, not from when the flow opened",
    flowStateBlock({ ...summarize, startedAt: new Date("2026-09-05T09:00:00+05:30") })
        .includes("LOG DATE: 2026-09-04"));

ok("a flow with no scratchpad still derives LOG DATE from startedAt",
    flowStateBlock({ ...morning, startedAt: new Date("2026-09-05T09:00:00+05:30") })
        .includes("LOG DATE: 2026-09-05"));

// --------------------------------------------------------------- the schema --
const registry = fetchCollectionNameAndSchema();
ok("chatSummary is registered and writeable", registry[CHAT_SUMMARY]?.writeable === true);

ok("the uniqueness guard is declared",
    CHAT_SUMMARY_INDEXES.some(i => i.unique && JSON.stringify(i.key) === JSON.stringify({ userId: 1, period: 1, date: -1 })),
    "without unique on (userId, period, date) a double-fire writes two rows for one day");

const row = {
    userId: 1,
    period: "day",
    date: new Date("2026-09-04T00:00:00+05:30"),
    headline: "Discharged Thursday morning. Home, told to rest three days.",
    state: ["Advised rest, no exertion until Sun 7th", "Blood test results still pending"],
    openThreads: ["Waiting on blood test results"],
    mentioned: ["Finished Loki while in hospital"],
    followThrough: "Planned gym and deck work; did neither, sick from midday.",
    mood: "tired, relieved",
};
await ValidateSchema(CHAT_SUMMARY, row).then(
    () => passed++,
    e => failures.push(`a well-formed row validates\n     ${e.message}`)
);

await throws("period is enum-checked",
    () => ValidateSchema(CHAT_SUMMARY, { ...row, period: "daily" }), /must be one of/);
// Spread with `undefined` still creates the key, and the required check is
// `field in userData` — so the field has to be deleted to test its absence.
const headless = { ...row };
delete headless.headline;
await throws("headline is required",
    () => ValidateSchema(CHAT_SUMMARY, headless), /headline is required/);
await throws("state must be strings, not objects",
    () => ValidateSchema(CHAT_SUMMARY, { ...row, state: [{ text: "x" }] }), /invalid type/);

ok("null is allowed where the day gives no signal",
    await ValidateSchema(CHAT_SUMMARY, { ...row, mood: null, followThrough: null }).then(() => true, () => false));

// -------------------------------------------------- free text is not a date --
// normalizeDates converts any top-level string Date.parse accepts, and
// Date.parse accepts far more than ISO. A headline opening on a month name
// would be replaced by a Date object, and the day's memory lost — the same
// class of bug as the userId string that parsed to year 123.
const prose = normalizeDates({
    headline: "Sept 4 was rough — hospital most of the day.",
    mood: "May be better tomorrow",
    followThrough: "March through the backlog tomorrow",
    date: "2026-09-04",
});
ok("a headline survives normalizeDates", typeof prose.headline === "string", `got ${prose.headline}`);
ok("a mood survives normalizeDates", typeof prose.mood === "string", `got ${prose.mood}`);
ok("followThrough survives normalizeDates", typeof prose.followThrough === "string", `got ${prose.followThrough}`);
ok("the date field is still coerced", prose.date instanceof Date, `got ${prose.date}`);

// ------------------------------------------------------------ the day range --
// Half-open, so no turn falls into a millisecond hole between two days.
const { start, end } = localDayRange("2026-09-04");
ok("a day range spans exactly 24h", end - start === 86400000);
ok("a day range starts at local midnight", start.toISOString() === "2026-09-03T18:30:00.000Z",
    `got ${start.toISOString()}`);

// ------------------------------------------------------------- the dispatch --
// Spread positionally, so a wrong order lands logDate in the userId slot and
// summarises nothing, forever, with no error.
ok("dispatcher params match the job signature",
    JSON.stringify(ACTION_MAP.summarizeDayJob.params) === JSON.stringify(["userId", "logDate", "timeZone"]));
ok("the dispatcher points at the real job", ACTION_MAP.summarizeDayJob.fn === summarizeDayJob);
// Function.length stops counting at the first defaulted parameter, so this is
// an upper bound rather than an equality. It still catches the failure that
// matters: a parameter the dispatcher never names arrives undefined.
ok("the job takes no parameter the dispatcher does not supply",
    summarizeDayJob.length <= ACTION_MAP.summarizeDayJob.params.length);

// ------------------------------------------------------- the recursion trap --
// A summarize turn persists like any other. Tagged, it can be filtered back out
// of history and out of tomorrow's transcript; untagged, the agent reads its
// own summarization exchange as something the user said.
ok("a turn records the entry point that produced it",
    new ConversationBuilder(1, "summarizeJob").build().source === "summarizeJob");
ok("an untagged turn is null rather than missing",
    new ConversationBuilder(1).build().source === null);

// ------------------------------------------------------------ the flow shape --
ok("the pass is exclusive and names its owner",
    summarizeFlow.exclusive === true && summarizeFlow.ownerSource === "summarizeJob");
ok("the overlay forbids writing the day's registers a second time",
    /Do NOT call createRecord on dietRegister/.test(summarizeFlow.instruction));
ok("the overlay states which field is carried forward",
    /carried forward/i.test(summarizeFlow.instruction));
ok("the expiry is short enough to bound a crashed pass",
    summarizeFlow.computeExpiry("Asia/Kolkata") - Date.now() <= 30 * 60 * 1000);

// ---------------------------------------------------------------- reporting --
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES\n" + failures.map(f => `  ✗ ${f}`).join("\n"));
    process.exit(1);
}
console.log("✓ summarize flow guards hold\n");
