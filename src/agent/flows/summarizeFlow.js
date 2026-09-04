import { IST_TIMEZONE, localDateOf } from "../../tools/mongo/dateUtils.js";
import dayTranscriptKnowledge from "../../knowledge/dayTranscriptKnowledge.js";
import { findDaySummary } from "../../tools/mongo/operation/chatSummaries.js";

/**
 * The pass that writes a day into chatSummary once the day is over.
 *
 * It is a flow rather than a bare LLM call so it reuses machinery that already
 * exists and is already tested: the overlay carries the procedure, buildContext
 * supplies live data on the system side, and FLOW STATE hands down the log date
 * as a literal instead of letting the model resolve "yesterday" against a clock
 * it will get wrong.
 *
 * It differs from goodMorning and goodNight in one way that matters: nobody is
 * on the other end. See `exclusive` below.
 */

// A system pass, not a conversation. runAgent applies this overlay ONLY to the
// job that owns it, and suppresses every other overlay while it runs — without
// that, a summarize pass entered at 09:02 (the no-reply path, minutes after the
// morning routine opens) would inherit the morning procedure and start planning
// the user's day instead of writing a row.
const EXCLUSIVE = true;
const OWNER_SOURCE = "summarizeJob";

// Deliberately short. This flow is opened and closed inside one job; the expiry
// only matters when that job dies mid-pass. Every minute it stays open is a
// minute a user message could arrive with a stale flow on their account — and
// while the ownerSource check above means they would not SEE this overlay, a
// short window is the belt to that pair of braces.
const TTL_MINUTES = 20;

const PREVIOUS_DAY_MS = 86400000;

export function buildSummarizeTriggerPrompt(logDate) {
    return `The day ${logDate} is over. Write its summary row now, following the routine.`;
}

/**
 * The two things the pass cannot get from a tool: the day's raw transcript
 * (chatHistory is deliberately not readable through fetchRecord) and the
 * previous row it must carry state forward from.
 *
 * Never throws. A failed read here should cost detail, not the day — the model
 * is told what is missing and writes what it can.
 */
export async function buildSummarizeContext(userId, { flow, timeZone = IST_TIMEZONE } = {}) {
    const logDate = flow?.scratchpad?.logDate ?? localDateOf(flow?.startedAt, timeZone);
    if (!logDate) throw new Error("no log date on the summarize flow — cannot tell which day to write");

    const previousDate = localDateOf(
        new Date(new Date(`${logDate}T12:00:00Z`).getTime() - PREVIOUS_DAY_MS),
        "UTC"
    );

    const [transcript, previous] = await Promise.all([
        dayTranscriptKnowledge(userId, logDate, { timeZone })
            .catch(e => `(the transcript could not be read: ${e.message})`),
        findDaySummary(userId, previousDate).catch(() => null),
    ]);

    const previousBlock = previous
        ? [
            `PREVIOUS ROW — ${previousDate}. Carry state and openThreads forward from here.`,
            `  headline:      ${previous.headline}`,
            `  state:         ${renderList(previous.state)}`,
            `  openThreads:   ${renderList(previous.openThreads)}`,
            `  followThrough: ${previous.followThrough ?? "(none)"}`,
        ].join("\n")
        : `PREVIOUS ROW — none for ${previousDate}. This is the first row, or the day before was never summarised.\n` +
          `  There is nothing to carry forward. Write state and openThreads from the transcript alone.`;

    return [
        "-------------------------------------",
        "📊 SOURCE DATA — read from the database at the top of this turn",
        "-------------------------------------",
        previousBlock,
        "",
        `TRANSCRIPT — everything said on ${logDate}`,
        "Tool calls and their results are not shown. What a tool wrote is already a",
        "row in its own collection; do not re-summarise it. Summarise what was SAID.",
        "",
        transcript,
        "-------------------------------------",
    ].join("\n");
}

function renderList(items) {
    return items?.length ? items.map(i => `\n                   - ${i}`).join("") : "(empty)";
}

export const summarizeFlow = {
    flowType: "summarize",
    exclusive: EXCLUSIVE,
    ownerSource: OWNER_SOURCE,

    computeExpiry: () => new Date(Date.now() + TTL_MINUTES * 60 * 1000),

    buildTriggerPrompt: buildSummarizeTriggerPrompt,
    buildContext: buildSummarizeContext,

    instruction: `
-------------------------------------
🗂 ACTIVE ROUTINE: DAY SUMMARY
-------------------------------------
Nobody is reading this. You are not talking to the user — this runs after they
have gone to bed, or the next morning if they never replied. Do not greet, do
not ask anything, do not offer to help.

You have exactly one job: write ONE chatSummary row for the day named as LOG
DATE in the FLOW STATE block, using createRecord. Then say one short line about
what you wrote, and stop.

WHY THIS ROW EXISTS
  The agent's chat history is scoped to the current day, so at midnight it
  forgets everything. This row is what survives. Tomorrow morning it is read
  back into the prompt, and it is the only reason the agent will know the user
  was in hospital on Wednesday when it plans their Thursday.

  Write it for that reader: a version of you, tomorrow, with no memory of today
  and no ability to ask.

-------------------------------------
🛑 ABSOLUTE RULE — ONE WRITE, TO ONE COLLECTION
-------------------------------------
The ONLY tool call you may make in this routine is createRecord on chatSummary.

The day's meals, tasks and expenses were already logged during the wrap-up.
Writing them again creates duplicate rows that nobody will notice for weeks.
Do NOT call createRecord on dietRegister, taskRegister or expenseRegister.
Do NOT call updateRecords, createTask, insertSchedule, or any reminder tool.
Do NOT call rememberFact.
Do NOT call fetchRecord or fetchCollectionNameAndSchema — everything you need
is below, and the schema is printed in full.

If the transcript contains something that looks unlogged, that is not yours to
fix tonight. Put it in openThreads and move on.

-------------------------------------
🛑 ABSOLUTE RULE — THE DATE IS GIVEN TO YOU
-------------------------------------
Copy LOG DATE from the FLOW STATE block verbatim into the date field, as a bare
date string: "2026-09-04". No time, no "Z", no offset.

This routine runs AFTER the day it covers — usually late that night, sometimes
at nine the next morning. The date under RIGHT NOW is therefore often already
the wrong day. LOG DATE is always correct; RIGHT NOW is not.

-------------------------------------
📋 THE SCHEMA — chatSummary
-------------------------------------
{
  period:        "day",
  date:          <LOG DATE, copied verbatim>,
  headline:      <string, required>,
  state:         [<string>, ...],
  openThreads:   [<string>, ...],
  mentioned:     [<string>, ...],
  followThrough: <string or null>,
  mood:          <string or null>
}

Do not send a userId. It is stamped for you.

-------------------------------------
✍️ WHAT GOES IN EACH FIELD
-------------------------------------
Some fields describe THIS DAY and some describe WHERE THINGS STAND. The
difference is the whole design — get it wrong and the memory either forgets
what is still true, or repeats last week's news forever.

▸ headline — THIS DAY ONLY. One sentence.
  For every day except the most recent, this is the ONLY line tomorrow's agent
  will see. It has to stand completely alone, with no other context around it.
    Good: "Long work day, finished the Q3 deck. Started watching Loki."
    Bad:  "A productive day." (says nothing a week later)

▸ state — WHERE THINGS STAND. Carried forward.
  Things that are true about the user right now and are not stored anywhere
  else. Copy every entry from PREVIOUS ROW that is STILL true, then add what
  today changed, then drop what stopped being true.
    "Discharged Thu morning; advised rest, no exertion until Sun 7th"
    "Q3 deck review pushed to Mon 8th"
  Each entry must carry its own dates and stand on its own — tomorrow's reader
  sees this list without the headline that produced it.
  NOT for durable facts about who they are (vegetarian, lives in Pune). Those
  live in their profile already and repeating them here wastes the budget.
  NOT for anything already a row in taskCalendar, dietRegister, expenseRegister
  or triggerJob. A pending task is not state; the backlog holds it.

▸ openThreads — WHERE THINGS STAND. Carried forward.
  Questions with no answer yet, decisions not made, things being waited on.
    "Waiting on blood test results"
  Drop a thread when it is answered, or when it has quietly stopped mattering.
  Do not let this grow past about six entries — if it is longer, the oldest
  ones have stopped being live and should go.

▸ mentioned — THIS DAY ONLY. Never carried forward.
  Passing detail with no home anywhere else: a series they are watching, a
  person who came up, an opinion. Individually useless — this is the field that
  lets the agent answer "I told you last week I was watching Loki" instead of
  drawing a blank.
  Two to five entries on a talkative day. Empty is a perfectly good answer.

▸ followThrough — THIS DAY ONLY. One line, or null.
  What was planned against what actually happened. Null only if nothing was
  planned. Be accurate rather than kind — this is the field the agent uses to
  confront work that keeps slipping, and a soft version of it is worthless.
    "Planned gym and deck work; did neither, sick from midday."
    "Followed the schedule except the evening block."

▸ mood — THIS DAY ONLY. A few words. Null if the transcript gives no signal.

-------------------------------------
📏 LENGTH
-------------------------------------
This row is injected into a prompt every day for a week. Every word competes
with the rules the agent has to follow.

  headline       one sentence
  state          at most 6 entries, one line each
  openThreads    at most 6 entries, one line each
  mentioned      at most 5 entries, short
  followThrough  one sentence

Say less than you want to. If an entry does not change what the agent would do
or say tomorrow, leave it out.

-------------------------------------
🚫 WHAT NOT TO SUMMARISE
-------------------------------------
Most of the transcript's bulk is the agent's own generated text — the morning
schedule draft alone runs several thousand characters. That plan is already
stored in userSchedule. Do NOT retell it.

What matters is what the USER did with it: accepted it, changed it, ignored it,
never replied. That goes in followThrough.

The same applies to every "Logged: …" acknowledgement. The rows exist; the
acknowledgement is not news.

-------------------------------------
🏁 FINISHING
-------------------------------------
1. Call createRecord on chatSummary. Once.
2. If it fails, read the error and fix the payload — a validation message names
   the field. If it fails because a row already exists for this date, that day
   is already summarised: say so and stop. Do not write a second row.
3. Reply with one short line naming the day and the headline you wrote.
   Nobody reads it; it is for the log.

Do not call completeFlow. The job that opened this routine closes it.
-------------------------------------
`.trim(),
};

export default summarizeFlow;
