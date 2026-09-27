import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import { localDayRange } from "../tools/mongo/dateUtils.js";

/**
 * Today's reminders that fired and were never answered.
 *
 * A reminder arrives with Done / Missed buttons. Tapping one is the fast path,
 * but most of the time nobody taps anything — the phone buzzes during a meeting
 * and the message scrolls away. Those are exactly the ones worth raising at
 * wrap-up, because an unanswered reminder is the only signal in the system that
 * something planned may simply not have happened.
 *
 * Only `sendReminder` rows are considered. Reminders written before the buttons
 * existed carry `sendToUser` and have no way to be answered, so counting them
 * would put the same handful of legacy rows in front of the user every single
 * night with no action that could ever clear them.
 *
 * Scoped to the flow's LOG DATE, not to "now". The night flow opens at 23:00 and
 * is often answered after midnight, so a window anchored on the current clock
 * would drop the evening's own reminders at the moment they matter most. Same
 * rule as every other night block.
 */

/**
 * Did this row's LAST firing get an answer?
 *
 * `reminderResponse` holds one answer, tagged with the firing it belongs to. A
 * daily reminder fires against the same row every day, so comparing the stored
 * `forExecutionAt` against `lastExecutedAt` is what separates "answered today"
 * from "answered yesterday and untouched since".
 *
 * Exported and pure so the comparison is tested without a database — it is the
 * whole correctness of this block.
 */
export function isUnattended(job, { start, end } = {}) {
    const firedAt = job?.lastExecutedAt;
    if (!firedAt) return false;                       // never fired: nothing to ask about

    if (start && end) {
        const t = firedAt.getTime();
        if (t < start.getTime() || t >= end.getTime()) return false;  // fired another day
    }

    const answer = job.reminderResponse;
    if (!answer?.status) return true;                  // fired, never answered

    // Answered — but which firing? An answer to an earlier one leaves today's open.
    const answeredFor = answer.forExecutionAt?.getTime?.();
    return answeredFor !== firedAt.getTime();
}

const clockOf = (d, timeZone) =>
    d instanceof Date
        ? d.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" })
        : "unknown";

/**
 * Pure render, so the block's wording and its empty case are tested without a
 * database — same split as renderLoggedSoFar.
 */
export function renderUnattendedReminders(jobs = [], { timeZone = "Asia/Kolkata" } = {}) {
    if (!jobs.length) return null;

    const out = [
        "-------------------------------------",
        "🔔 REMINDERS THAT WENT UNANSWERED TODAY",
        "-------------------------------------",
        "Each of these fired and they never said whether it happened. Ask about",
        "them as part of the wrap-up — briefly, all in one question if there are",
        "several, and only once.",
        "  • They did it            -> answerReminder(id, \"completed\"), and log the work if it belongs in the day's record.",
        "  • It did not happen      -> answerReminder(id, \"missed\").",
        "  • They do not say        -> leave it. Do not guess, and do not ask a second time.",
        "",
    ];

    for (const j of jobs) {
        const text = String(j.payload?.text ?? "").replace(/^\s*\[\*?\s*REMINDER\s*\*?\]\s*/i, "").trim();
        out.push(`  ${clockOf(j.lastExecutedAt, timeZone)}  ${text || j.title}`);
        out.push(`         _id ${String(j._id)}${j.recurring ? "  (recurring)" : ""}`);
    }

    return out.join("\n");
}

export default async function unattendedRemindersKnowledge(userId, logDate, { timeZone = "Asia/Kolkata" } = {}) {
    const { start, end } = localDayRange(logDate);
    const db = await getDB();

    // Narrowed in the query by the two things an index can serve, then filtered
    // in JS: the answered/unanswered comparison is between two fields on the
    // same row, which would need an $expr, and this is a handful of rows per
    // user per day.
    const fired = await db.collection(TRIGGER_JOB)
        .find({
            userId,
            actionType: "sendReminder",
            lastExecutedAt: { $gte: start, $lt: end },
        })
        .project({ title: 1, payload: 1, lastExecutedAt: 1, reminderResponse: 1, recurring: 1 })
        .toArray();

    const open = fired
        .filter(j => isUnattended(j, { start, end }))
        .sort((a, b) => a.lastExecutedAt - b.lastExecutedAt);

    return renderUnattendedReminders(open, { timeZone });
}
