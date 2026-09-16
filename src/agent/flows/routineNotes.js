import goodNightFlow from "./goodNightFlow.js";
import goodMorningFlow from "./goodMorningFlow.js";
import { claimNudge } from "../../tools/mongo/operation/userNotes.js";

/**
 * What the daily routines do with the user's notes, beyond reading them.
 *
 * Kept out of each routine's own instruction on purpose. Both routines need it,
 * it is the same rule in both, and it is appended by runAgent the way FLOW STATE
 * is — so the routines' procedures stay about their own job, and there is one
 * place that decides how often a goal may be raised.
 */

export const ROUTINE_FLOW_TYPES = Object.freeze([goodMorningFlow.flowType, goodNightFlow.flowType]);

/**
 * The permission itself. Shown on exactly one turn a week — the turn that won
 * claimNudge — so it can speak about "this reply" and mean it.
 *
 * It grants a chance, not a duty. Everything that would make this nagging is
 * spelled out: one thing, folded into what the routine is already doing rather
 * than asked as a second question, and nothing at all when nothing is slipping
 * or they are having a hard day.
 */
export const NUDGE_BLOCK = `
-------------------------------------
🎯 A GOAL YOU MAY RAISE — this reply only
If ONE habit or goal in your notes has clearly slipped — skipped for days,
or no progress in weeks — end this reply with one short line about it:
  "The gym's been skipped all week — want a session in tomorrow's plan?"
If this reply already asks them something, fold it in:
do not add a second question.
If nothing has slipped, or they are overloaded today, say nothing about goals.
You will not get this chance again this week.
-------------------------------------
`.trim();

/**
 * The night routine is where the notes get kept current, because it is the one
 * moment every day the user says what actually happened.
 *
 * "Slowly" is the substance. A routine rewritten after every late night is
 * noise the model then asserts every morning as fact, so a change has to hold —
 * something they say has been true for a while, or that shows up across several
 * days in RECENTLY — before the routine section moves. That is judgement, not
 * arithmetic, and deliberately so: the evidence is in what they say, which no
 * sampled wake-up time captures.
 *
 * Logging the day stays first. Notes upkeep that delays or displaces a log is
 * the wrong trade every time.
 */
export const NIGHT_NOTES_BLOCK = `
-------------------------------------
📝 YOUR NOTES
Before closing, check whether today changed their routine, habits or goals
in your notes. Most nights it does not — then leave them alone.
Their routine drifts slowly. One late night or one early start is not a new
routine: rewrite it only when they say it has held for a while, or it shows
across several days in RECENTLY. A habit skipped once is not slipping.
Use updateNotes, silently. Logging today comes first.
-------------------------------------
`.trim();

/** The notes block for the night routine, or null. Pure — no claim, no query. */
export function notesUpkeep(openFlows = []) {
    return (openFlows || []).some(flow => flow?.flowType === goodNightFlow.flowType)
        ? NIGHT_NOTES_BLOCK
        : null;
}

/**
 * The nudge block for this turn, or null.
 *
 * Claims only when a routine is actually open. An ordinary conversation turn
 * must never spend the week's chance, and must not pay for a database write to
 * learn it has nothing to do.
 *
 * A claim that fails costs the nudge, never the turn — the routine goes on
 * without it, and the week is still unspent.
 */
export async function routineNudge(openFlows = [], { userId, claim = claimNudge, now = new Date() } = {}) {
    const inRoutine = (openFlows || []).some(flow => ROUTINE_FLOW_TYPES.includes(flow?.flowType));
    if (!inRoutine) return null;

    try {
        return (await claim(userId, now)) ? NUDGE_BLOCK : null;
    } catch (err) {
        console.warn("[routineNotes] could not claim the weekly nudge:", err.message);
        return null;
    }
}
