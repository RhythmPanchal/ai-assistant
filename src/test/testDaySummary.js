/**
 * Hand-run:  node src/test/testDaySummary.js
 *
 * Guards the day-summary pass. No .env, no network, no DB — the parse and the
 * row build are pure, which is the point of the model returning content fields
 * rather than writing the row itself.
 *
 * For the model's actual output, see testSummarizeLive.js.
 */
import assert from "node:assert";

import { extractJson, coerceRow, buildMessages } from "../agent/summarize/summarizeDay.js";
import { DAY_SUMMARY_INSTRUCTION } from "../agent/summarize/dayPrompt.js";
import { ACTION_MAP } from "../scheduler/actionDispatcher.js";
import { summarizeDayJob } from "../scheduler/jobs/summarizeDayJob.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { CHAT_SUMMARY, CHAT_SUMMARY_INDEXES } from "../tools/mongo/schema/chatSummarySchema.js";
import ValidateSchema, { normalizeDates } from "../tools/mongo/validateSchema.js";
import { localDayRange, previousDay } from "../tools/mongo/dateUtils.js";

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => cond ? passed++ : failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
const throws = (name, fn, matcher) => {
    try { fn(); failures.push(`${name}\n     expected a throw, got none`); }
    catch (e) {
        if (matcher && !matcher.test(e.message)) failures.push(`${name}\n     got: ${e.message}`);
        else passed++;
    }
};

const GOOD = {
    headline: "Admitted to hospital overnight for observation.",
    state: ["No exertion until Sun 7th"],
    openThreads: ["Waiting on blood test results"],
    mentioned: ["watching Loki, enjoying it"],
    followThrough: "Planned a light day, finished nothing.",
    mood: "unwell",
};

// ------------------------------------------------------------- JSON rescue --
// The summarize chain leads on the highest-volume models rather than the most
// obedient. Every wrapper below is one they actually produce.
ok("plain JSON parses", extractJson(JSON.stringify(GOOD)).headline === GOOD.headline);
ok("a ```json fence is stripped",
    extractJson("```json\n" + JSON.stringify(GOOD) + "\n```").headline === GOOD.headline);
ok("a bare ``` fence is stripped",
    extractJson("```\n" + JSON.stringify(GOOD) + "\n```").headline === GOOD.headline);
ok("a preamble is skipped",
    extractJson("Here is the summary:\n" + JSON.stringify(GOOD)).headline === GOOD.headline);
ok("a trailing remark is ignored",
    extractJson(JSON.stringify(GOOD) + "\n\nLet me know if you need anything else.").headline === GOOD.headline);
ok("nested braces survive the slice",
    extractJson('prose {"headline":"a {brace} inside","state":[]} more').headline === "a {brace} inside");

throws("prose with no object is refused", () => extractJson("I could not summarise that day."), /no JSON object/);
throws("malformed JSON is refused", () => extractJson('{"headline": "x",,}'), /not valid JSON/);
throws("an empty reply is refused", () => extractJson(""), /no text/);

// ------------------------------------------------------------- the row build --
// The model supplies content only. Every identifying field comes from arguments
// it never sees, which is what removes the wrong-day and wrong-user failures
// entirely rather than instructing against them.
const row = coerceRow(GOOD, { userId: 7, logDate: "2026-09-03" });
ok("userId comes from the caller", row.userId === 7);
ok("period is fixed", row.period === "day");
ok("date comes from the caller, at local midnight",
    row.date.toISOString() === "2026-09-02T18:30:00.000Z", row.date.toISOString());

const injected = coerceRow(
    { ...GOOD, userId: 99, date: "1999-01-01", period: "month", _id: "deadbeef" },
    { userId: 7, logDate: "2026-09-03" }
);
ok("a model-supplied userId is discarded", injected.userId === 7);
ok("a model-supplied date is discarded", injected.date.toISOString() === "2026-09-02T18:30:00.000Z");
ok("a model-supplied period is discarded", injected.period === "day");
ok("unknown fields are dropped", !("_id" in injected));

// Caps re-applied in code. A prompt is guidance; this is what stops one
// over-eager generation growing every future prompt by a dozen lines.
const flooded = coerceRow({
    ...GOOD,
    state: Array.from({ length: 30 }, (_, i) => `s${i}`),
    openThreads: Array.from({ length: 30 }, (_, i) => `t${i}`),
    mentioned: Array.from({ length: 30 }, (_, i) => `m${i}`),
}, { userId: 1, logDate: "2026-09-03" });
ok("state is capped at 6", flooded.state.length === 6);
ok("openThreads is capped at 6", flooded.openThreads.length === 6);
ok("mentioned is capped at 5", flooded.mentioned.length === 5);

const messy = coerceRow({
    ...GOOD,
    state: ["  padded  ", "", null, 42, { a: 1 }, "real"],
    mentioned: "not an array",
    followThrough: "null",
    mood: "  ",
}, { userId: 1, logDate: "2026-09-03" });
ok("blank and non-string entries are dropped", messy.state.length === 2);
ok("entries are trimmed", messy.state[0] === "padded");
ok("a non-array becomes an empty list", Array.isArray(messy.mentioned) && messy.mentioned.length === 0);
ok('the literal string "null" becomes null', messy.followThrough === null);
ok("a whitespace-only field becomes null", messy.mood === null);

throws("a missing headline is a failed generation, not an empty day",
    () => coerceRow({ state: [] }, { userId: 1, logDate: "2026-09-03" }), /no usable headline/);
throws("a one-word headline is refused",
    () => coerceRow({ headline: "ok" }, { userId: 1, logDate: "2026-09-03" }), /no usable headline/);

ok("a coerced row validates against the schema",
    await ValidateSchema(CHAT_SUMMARY, row).then(() => true, () => false));

// --------------------------------------------------------------- what is sent --
// The whole reason this is not a runAgent turn: no history, no tools, no
// persona. A pass at 00:10 on the 4th summarising the 3rd would otherwise be
// handed the tail of the 3rd as live conversation.
const messages = buildMessages({ logDate: "2026-09-03", transcript: "[09:00] user: hi", previous: null });
ok("exactly two messages are sent", messages.length === 2);
ok("the first is the instruction", messages[0].role === "system" && messages[0].content === DAY_SUMMARY_INSTRUCTION);
ok("the second is the day", messages[1].role === "user" && messages[1].content.includes("[09:00] user: hi"));
ok("the log date is stated as a literal", messages[1].content.includes("2026-09-03"));
ok("the weekday is resolved for the model", messages[1].content.includes("Thursday"));
ok("no previous row is stated plainly", /PREVIOUS STATE — none/.test(messages[1].content));

const carried = buildMessages({
    logDate: "2026-09-03",
    transcript: "x",
    previous: { date: new Date("2026-09-02T00:00:00+05:30"), state: ["still true"], openThreads: ["still open"] },
});
ok("previous state is handed over for carry-forward",
    carried[1].content.includes("still true") && carried[1].content.includes("still open"));

ok("the instruction forbids retelling the schedule draft",
    /Do NOT retell it/.test(DAY_SUMMARY_INSTRUCTION));
ok("the instruction demands a bare JSON object",
    /Start your reply with \{ and end it with \}/.test(DAY_SUMMARY_INSTRUCTION));

// --------------------------------------------------------------- the schema --
ok("chatSummary is registered and writeable", fetchCollectionNameAndSchema()[CHAT_SUMMARY]?.writeable === true);
ok("the uniqueness guard is declared",
    CHAT_SUMMARY_INDEXES.some(i => i.unique && JSON.stringify(i.key) === JSON.stringify({ userId: 1, period: 1, date: -1 })),
    "without unique on (userId, period, date) a double-fire writes two rows for one day");

// -------------------------------------------------- free text is not a date --
// normalizeDates converts any top-level string Date.parse accepts, and
// Date.parse accepts far more than ISO — the same class of bug as the userId
// string that parsed to year 123.
const prose = normalizeDates({
    headline: "Sept 4 was rough — hospital most of the day.",
    mood: "May be better tomorrow",
    followThrough: "March through the backlog tomorrow",
    date: "2026-09-04",
});
ok("a headline survives normalizeDates", typeof prose.headline === "string", `got ${prose.headline}`);
ok("a mood survives normalizeDates", typeof prose.mood === "string", `got ${prose.mood}`);
ok("followThrough survives normalizeDates", typeof prose.followThrough === "string", `got ${prose.followThrough}`);
ok("the date field is still coerced", prose.date instanceof Date);

// ------------------------------------------------------------------- dates --
const { start, end } = localDayRange("2026-09-04");
ok("a day range spans exactly 24h", end - start === 86400000);
ok("a day range starts at local midnight", start.toISOString() === "2026-09-03T18:30:00.000Z");
ok("previousDay crosses a month", previousDay("2026-09-01") === "2026-08-31");
ok("previousDay crosses a year", previousDay("2026-01-01") === "2025-12-31");
ok("previousDay handles February", previousDay("2026-03-01") === "2026-02-28");

// --------------------------------------------------------------- the dispatch --
// Spread positionally, so a wrong order lands logDate in the userId slot and
// summarises nothing, forever, with no error.
ok("dispatcher params match the job signature",
    JSON.stringify(ACTION_MAP.summarizeDayJob.params) === JSON.stringify(["userId", "logDate", "timeZone"]));
ok("the dispatcher points at the real job", ACTION_MAP.summarizeDayJob.fn === summarizeDayJob);
ok("the job takes no parameter the dispatcher does not supply",
    summarizeDayJob.length <= ACTION_MAP.summarizeDayJob.params.length);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES\n" + failures.map(f => `  ✗ ${f}`).join("\n"));
    process.exit(1);
}
console.log("✓ day summary guards hold\n");
