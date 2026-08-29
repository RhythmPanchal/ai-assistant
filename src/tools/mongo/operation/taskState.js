import { ObjectId } from "mongodb";

import { getDB } from "../mongoClient.js";
import { TASK_CALENDAR } from "../schema/taskCalendarSchema.js";
import { toIST, localDateOf, IST_TIMEZONE } from "../dateUtils.js";

/**
 * Closing, cancelling and deferring tasks — the half of taskCalendar that never
 * existed.
 *
 * On 2026-08-22 the user said "compaction prod vala to usi din ho gaya tha".
 * The agent replied "Got it" and changed nothing, because there was no way for
 * it to. The generic route is fetchRecord -> updateRecords, and during the
 * morning routine both are unavailable: the trigger prompt forbade fetching, and
 * pendingTasksKnowledge stripped `_id` before inlining the list, so HARD RULE 2
 * ("never invent an _id") left the model with a backlog it could read and not
 * address. That task was still Pending ten days and four re-drafted schedules
 * later.
 *
 * These functions take a task the way a person names one — an id if it has been
 * shown one, otherwise the title — so "that one's done" is a single call from
 * any turn, routine or not.
 */

const CLOSED_STATES = new Set(["Completed", "Cancelled"]);
export const TASK_STATUSES = ["Pending", "Scheduled", "Completed", "Cancelled"];

const HEX_ID = /^[0-9a-fA-F]{24}$/;

// Titles are matched the way a person would read them out, not byte for byte:
// case and spacing vary between what the model was shown and what it sends back.
function normaliseTitle(title) {
    return String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Find the one task `ref` names, or explain why it could not.
 *
 * Never guesses between candidates. Two Pending rows with the same title is the
 * exact state the backlog was in, and silently closing the wrong one is worse
 * than asking.
 *
 * @param {number} userId
 * @param {string} ref     a 24-hex _id, or the task's title
 * @returns {Promise<{task?: object, error?: string}>}
 */
export async function resolveTaskRef(userId, ref) {
    const db = await getDB();
    const col = db.collection(TASK_CALENDAR);
    const raw = String(ref ?? "").trim();

    if (!raw) return { error: "No task given — pass the task's id or its exact title." };

    if (HEX_ID.test(raw)) {
        const task = await col.findOne({ _id: ObjectId.createFromHexString(raw), userId });
        return task
            ? { task }
            : { error: `No task ${raw} belongs to this user. Do not retry with a made-up id — use the title instead.` };
    }

    // Scoped to the user, then matched in memory: the collection is small, and
    // a regex over an unindexed field would not use userId_1_status_1 anyway.
    const owned = await col.find({ userId }).toArray();
    const wanted = normaliseTitle(raw);
    let matches = owned.filter(t => normaliseTitle(t.title) === wanted);

    // Only widen when nothing matched exactly — a substring search run first
    // would let "gym" collide with two rows that an exact title separates.
    if (!matches.length) {
        matches = owned.filter(t => normaliseTitle(t.title).includes(wanted) && wanted.length >= 4);
    }

    // An open task is almost always the one meant; a closed one of the same name
    // is history. Only fall back to the closed rows when there are no open ones.
    const open = matches.filter(t => !CLOSED_STATES.has(t.status));
    const pool = open.length ? open : matches;

    if (!pool.length) {
        return { error: `No task matches "${raw}". Ask which task they mean rather than guessing.` };
    }
    if (pool.length > 1) {
        const list = pool.map(t => `${t._id} "${t.title}" (${t.status})`).join("; ");
        return { error: `"${raw}" matches ${pool.length} tasks — pass the id of the right one: ${list}` };
    }
    return { task: pool[0] };
}

/**
 * Move one or more tasks to a new status.
 *
 * Batched because corrections arrive in batches: "this is done, that one drop
 * it, and the gym one I'll do next week" is one message. Each entry succeeds or
 * fails on its own — one unresolvable title must not lose the other four
 * updates, and the per-entry errors go back to the model so it can ask about
 * just that one.
 *
 * @param {number} userId
 * @param {Array<{task: string, status: string, note?: string}>} updates
 */
export async function updateTaskStatus(userId, updates) {
    if (!userId) return { success: false, error: "userId is required." };
    if (!Array.isArray(updates) || !updates.length) {
        return { success: false, error: "updates must be a non-empty array." };
    }

    const db = await getDB();
    const col = db.collection(TASK_CALENDAR);
    const now = new Date();
    const updated = [];
    const failed = [];

    for (const entry of updates) {
        const { task: ref, status, note } = entry ?? {};
                                                                                            
        if (!TASK_STATUSES.includes(status)) {
            failed.push({ task: ref, error: `status must be one of ${TASK_STATUSES.join(", ")} — got "${status}".` });
            continue;
        }

        const { task, error } = await resolveTaskRef(userId, ref);
        if (error) { failed.push({ task: ref, error }); continue; }

        if (task.status === status) {
            // Not a failure: the outcome the caller wanted already holds. Said
            // plainly so the model does not report a change that did not happen.
            updated.push({ id: String(task._id), title: task.title, from: status, to: status, unchanged: true });
            continue;
        }

        const patch = {
            status,
            updatedAt: now,
            // Reopening has to clear this or the task stays stamped with a
            // completion it no longer has.
            completedAt: CLOSED_STATES.has(status) ? now : null,
        };
        if (note) patch.notes = appendNote(task.notes, now, note);

        await col.updateOne({ _id: task._id }, { $set: patch });
        updated.push({ id: String(task._id), title: task.title, from: task.status, to: status });
    }

    return { success: failed.length === 0, updated, failed };
}

/**
 * Move a task's deadline, and count that it moved.
 *
 * The count is the point. A task with deferCount 4 is not being scheduled, it is
 * being avoided, and that is only visible if each push is recorded rather than
 * the deadline being quietly overwritten. `originalDeadline` is captured once so
 * "you said the 10th" survives every later move.
 *
 * @param {number} userId
 * @param {string} ref          id or title
 * @param {string} newDeadline  naive local ISO, e.g. "2026-09-02T18:00:00"
 * @param {string} [reason]     what the user actually said
 */
export async function deferTask(userId, ref, newDeadline, reason) {
    if (!userId) return { success: false, error: "userId is required." };

    const { task, error } = await resolveTaskRef(userId, ref);
    if (error) return { success: false, error };

    const deadline = toIST(newDeadline);
    if (!deadline || isNaN(deadline.getTime())) {
        return { success: false, error: `"${newDeadline}" is not a usable date. Use "YYYY-MM-DD" or naive local ISO.` };
    }

    const db = await getDB();
    const now = new Date();
    const previous = task.deadline ? new Date(task.deadline) : null;

    const patch = {
        deadline,
        deferCount: (task.deferCount ?? 0) + 1,
        updatedAt: now,
        // A task being given a date again is back in play, whatever it was.
        status: CLOSED_STATES.has(task.status) ? task.status : "Pending",
    };
    // Only on the first move, and only if there was something to preserve.
    if (!task.originalDeadline && previous) patch.originalDeadline = previous;

    // Day labels in the user's zone, not the host's. A trail that says
    // "deadline 2026-06-09" about a deadline the list shows as 2026-06-10 is a
    // trail nobody trusts.
    const day = (d) => localDateOf(d, IST_TIMEZONE);
    const trail = [
        previous ? `deadline ${day(previous)} -> ${day(deadline)}` : `deadline set ${day(deadline)}`,
        reason,
    ].filter(Boolean).join(" — ");
    patch.notes = appendNote(task.notes, now, trail);

    await db.collection(TASK_CALENDAR).updateOne({ _id: task._id }, { $set: patch });

    return {
        success: true,
        id: String(task._id),
        title: task.title,
        deferCount: patch.deferCount,
        originalDeadline: task.originalDeadline ?? previous ?? null,
        deadline,
    };
}

/** Newest last, one line each, so the trail reads in order and never overwrites. */
function appendNote(existing, at, text) {
    const line = `[${localDateOf(at, IST_TIMEZONE)}] ${text}`;
    return existing ? `${existing}\n${line}` : line;
}
