import { getDB } from "../tools/mongo/mongoClient.js";
import { TASK_CALENDAR } from "../tools/mongo/schema/taskCalendarSchema.js";
import { IST_TIMEZONE, localDateOf } from "../tools/mongo/dateUtils.js";

/**
 * The backlog, rendered for the model.
 *
 * Two things changed here after the 2026-08-22 failure, and both were the same
 * mistake in different clothes.
 *
 * The `_id` used to be stripped, for token thrift. It cost about six hundred
 * tokens a day and made the entire list unaddressable: HARD RULE 2 forbids
 * inventing an id, so the model could read every pending task and could not name
 * one of them to a tool. When the user said a task was already done, there was
 * no call available that would have closed it. The id is back.
 *
 * And the raw rows said `deadline: "2026-06-10"` with no comment. Nothing in the
 * prompt turned that into "seventy-nine days ago", so seventy-nine days of
 * slippage read exactly like a date. Age and lateness are computed here instead
 * of hoped for.
 *
 * Ordering is worst-first — the most overdue at the top, then priority — because
 * that is the order the day should be argued about, and a model skimming a long
 * list weights the top of it.
 */

const STALE_AFTER_DAYS = 21;

function daysBetween(from, to) {
    return Math.floor((to - from) / 86400000);
}

/** One line per task. Compact enough to be cheap, explicit enough to act on. */
export function formatPendingTasksForLLM(records, now = new Date(), timeZone = IST_TIMEZONE) {
    if (!records.length) return "No pending tasks.";

    const today = new Date(`${localDateOf(now, timeZone)}T00:00:00`);

    const rows = records.map((task) => {
        const deadline = task.deadline ? new Date(task.deadline) : null;
        const deadlineDay = deadline ? new Date(`${localDateOf(deadline, timeZone)}T00:00:00`) : null;
        const overdueDays = deadlineDay ? daysBetween(deadlineDay, today) : null;
        const ageDays = task.createdAt ? daysBetween(new Date(task.createdAt), today) : null;
        return { task, deadline, overdueDays, ageDays };
    });

    // Late first, and among the late the latest; then priority; then oldest.
    rows.sort((a, b) => {
        const aLate = a.overdueDays > 0 ? a.overdueDays : -1;
        const bLate = b.overdueDays > 0 ? b.overdueDays : -1;
        if (aLate !== bLate) return bLate - aLate;
        const aPri = a.task.priorityScore ?? 9;
        const bPri = b.task.priorityScore ?? 9;
        if (aPri !== bPri) return aPri - bPri;
        return (b.ageDays ?? 0) - (a.ageDays ?? 0);
    });

    const lines = rows.map(({ task, deadline, overdueDays, ageDays }) => {
        const marks = [];
        if (deadline) {
            const day = localDateOf(deadline, timeZone);
            if (overdueDays > 0) marks.push(`due ${day} OVERDUE ${overdueDays}d`);
            else if (overdueDays === 0) marks.push(`due TODAY`);
            else marks.push(`due ${day} in ${-overdueDays}d`);
        }
        if (ageDays != null && ageDays >= STALE_AFTER_DAYS && !(overdueDays > 0)) {
            marks.push(`STALE opened ${ageDays}d ago`);
        }
        if (task.deferCount) marks.push(`PUSHED BACK ${task.deferCount}x`);
        if (task.requiredMinutes) marks.push(`${task.requiredMinutes}m`);
        if (task.category) marks.push(task.category);

        return `${task._id} | p${task.priorityScore ?? "-"} | ${task.title}${marks.length ? ` | ${marks.join(" | ")}` : ""}`;
    });

    const late = rows.filter(r => r.overdueDays > 0).length;
    const header =
        `${rows.length} pending${late ? `, ${late} past their deadline` : ""}. ` +
        `Columns: id | priority (1 highest) | title | flags. The id is real — use it in ` +
        `updateTaskStatus, deferTask and slot taskRef. Never invent one.`;

    return [header, ...lines].join("\n");
}

export default async function pendingTasksKnowledge(userId, timeZone = IST_TIMEZONE) {
    const db = await getDB();

    const records = await db.collection(TASK_CALENDAR)
        .find({ userId, status: { $in: ["Pending", "Scheduled"] } })
        .sort({ priorityScore: 1 })
        .toArray();

    return formatPendingTasksForLLM(records, new Date(), timeZone);
}
