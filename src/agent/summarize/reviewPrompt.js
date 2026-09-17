import { formatMinutes } from "./planComparison.js";

/**
 * The prompt for the day-review pass: which logged work filled which planned
 * block, and the day's productivity, mood, health and overall scores.
 *
 * A second call beside the summary rather than more fields on it. The summary is
 * memory, tuned and evaluated for what tomorrow's assistant must not forget; this
 * is a scorecard, and it needs the schedule and the task log laid out with ids to
 * point at. One prompt doing both would be longer, and every change to either
 * half would be a regression risk for the other.
 */

export const DAY_REVIEW_INSTRUCTION = `
You review one day of a person's life for their assistant, and return a single
JSON object. You are not talking to anyone: no greeting, no questions, no
explanation.

WHY THIS EXISTS
  The assistant keeps a scorecard of every day, so it can tell a good week from
  a bad one and notice when the plan it makes each morning does not survive the
  day. You supply the two things that need judgement: which logged work was
  which planned block, and the scores. Minutes, percentages and the verdict are
  worked out in code from your matches — do not calculate anything.

=====================================================================
OUTPUT — a JSON object and nothing else
=====================================================================
No prose before or after it, no code fence. Start your reply with { and end
it with }.

{
  "matches": [
    { "block": "b1", "work": ["w1"], "outcome": "done" }
  ],
  "productivity": { "score": 1-5 or null, "why": "string or null" },
  "mood":         { "score": 1-5 or null, "why": "string or null" },
  "health":       { "score": 1-5 or null, "why": "string or null" },
  "overall":      { "score": 1-5 or null, "why": "string or null" }
}

=====================================================================
MATCHES — which logged work filled which planned block
=====================================================================
One entry for every block under PLANNED, by its id (b1, b2, …).

  work     The ids of the LOGGED entries (w1, w2, …) that were this block's
           work. Match on what the work was, not on the wording: the plan is
           written in the assistant's words and the log in the person's. One
           piece of work fills one block at most. Work that was on no block
           belongs to none — leave it out, and it counts as unplanned.
           An entry marked "same backlog task" is already matched.

  outcome  "done"      it happened: logged, or plainly said in the transcript
           "partial"   some of it happened
           "not done"  it did not happen: they said so, or they went through
                       what they did that day and it was not part of it
           "unclear"   nothing logged and nothing said either way

A block being on the plan is not evidence that it happened. A block marked as
dropped during the day was taken off the plan after it was made — say what
became of it all the same. When PLANNED says there was no schedule, return
"matches": [].

=====================================================================
THE SCORES
=====================================================================
  1 very bad · 2 poor · 3 okay · 4 good · 5 excellent

Every score needs a "why": one short line naming what it rests on — what was
logged, or what they said. When the day gives no evidence for a score, return
{ "score": null, "why": null }. Never fill in a 3 for "don't know". If the
only "why" you can write is that something was not mentioned, not reported or
not noted, that is no evidence: the score is null.

▸ productivity — how much meaningful work got done.
  Judge the work itself, from LOGGED and from what they said about it.
  Following the plan is measured separately: a day that went to an urgent
  problem instead of the plan can still be productive, and a day that followed
  a thin plan need not be. Be accurate rather than kind — a cheerful day with
  little done is not a 4. Nothing logged and nothing said about work → null.

▸ mood — how they felt, only from what they said and how they said it, in
  whatever language they said it. A busy day is not a stressed day and a light
  day is not a happy one: never infer mood from the workload. Bored and flat
  are moods. If it changed through the day, score the day as a whole and say
  how it moved in "why".

▸ health — how their body did, as they describe it: illness, pain, tiredness,
  energy, sleep, and exercise they did. Meals and spending being logged say
  nothing about their health. Silence about their body is null.

▸ overall — the day as they would judge it looking back. It rests on the other
  three and on anything they said about the day itself.
`.trim();

const DROPPED = new Set(["Skipped", "Rescheduled"]);

/**
 * The day itself: the plan and the log with the ids the matches refer to, then
 * the transcript. The ONLY other message sent.
 *
 * @param {object}   args
 * @param {object[]} args.blocks from workBlocksOf
 * @param {object[]} args.work   from workItemsOf
 */
export function buildDayReviewInput({ logDate, weekday, blocks = [], work = [], transcript }) {
    const sameTask = (taskId) => taskId && blocks.find(b => b.taskRef === taskId);

    const planned = blocks.length
        ? blocks.map(b => {
            const partner = work.find(w => w.taskId && w.taskId === b.taskRef);
            const notes = [
                formatMinutes(b.minutes),
                b.category,
                DROPPED.has(b.status) ? `dropped during the day (${b.status})` : null,
                partner ? `same backlog task as ${partner.id}` : null,
            ].filter(Boolean).join(", ");
            return `  ${b.id}  ${b.startTime}-${b.endTime}  ${b.title}  (${notes})`;
        })
        : ["  There was no schedule for this day."];

    const logged = work.length
        ? work.map(w => {
            const block = sameTask(w.taskId);
            const notes = [
                w.status === "Skipped" ? "logged as skipped" : formatMinutes(w.minutes),
                w.status === "Partial" ? "partly done" : null,
                block ? `same backlog task as ${block.id}` : null,
            ].filter(Boolean).join(", ");
            return `  ${w.id}  ${w.title}  (${notes})`;
        })
        : ["  Nothing was logged."];

    return [
        `THE DAY: ${logDate} (${weekday})`,
        "",
        "PLANNED — the schedule locked in for the day; meals, breaks and sleep are left out",
        ...planned,
        "",
        "LOGGED — the work the task log says was done",
        ...logged,
        "",
        "=====================================================================",
        `TRANSCRIPT — everything said on ${logDate}, in order`,
        "=====================================================================",
        transcript,
        "=====================================================================",
        "",
        `Return the JSON object for ${logDate} now.`,
    ].join("\n");
}
