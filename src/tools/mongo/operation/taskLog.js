import { getDB } from "../mongoClient.js";
import { TASK_REGISTER } from "../schema/taskRegisterSchema.js";
import ValidateSchema from "../validateSchema.js";
import { localDayRange } from "../dateUtils.js";
import { resolveLogDate } from "./logDate.js";

/**
 * Work done, appended to the day's task log.
 *
 * taskRegister has the same shape as dietRegister — one document per day, a
 * list inside it — and the same failure through updateRecords: logging a
 * second task meant re-sending the whole list, and a task left out of the
 * rebuild was erased. So the model supplies ONE task and code appends it.
 *
 * A repeat of a title already logged that day is refused. Two meals of the
 * same type are ordinary; the same piece of work twice in one day almost never
 * is, and re-logging what it cannot see is a failure this assistant has shown —
 * the first night eval saved one ₹50 rickshaw three times.
 */

export const TASK_LOG_STATUSES = ["Completed", "Partial", "Skipped"];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DUPLICATE_KEY = 11000;

const normaliseTitle = (t) => String(t ?? "").trim().toLowerCase();

/**
 * The model's task, made storable — or an Error telling it what to fix.
 *
 * Duration is required and never defaulted: the schema needs a positive number,
 * and "finished the deck" says nothing about how long. A guessed 60 would sit in
 * the log as if the user had said it. Ask, or estimate only when they gave a
 * clue ("most of the afternoon").
 */
export function buildPerformedTask(input = {}) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new Error("title is required — the work the user did, in their words.");

    const minutes = Number(input.actualDurationMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
        throw new Error(`"${title}" has no duration. Ask the user roughly how long it took, then call again.`);
    }

    const status = input.status ?? "Completed";
    if (!TASK_LOG_STATUSES.includes(status)) {
        throw new Error(`status must be one of ${TASK_LOG_STATUSES.join(", ")}. Got: ${status}`);
    }

    const taskId = input.taskId == null || input.taskId === "" ? null : String(input.taskId);
    if (taskId && !OBJECT_ID.test(taskId)) {
        throw new Error(`taskId "${taskId}" is not an id. Pass the 24-character id updateTaskStatus returned, or leave it out.`);
    }

    const task = {
        taskId,
        title,
        category: typeof input.category === "string" && input.category.trim() ? input.category.trim() : "General",
        status,
        actualDurationMinutes: Math.round(minutes),
    };

    for (const field of ["actualFrom", "actualTo"]) {
        if (input[field] == null || input[field] === "") continue;
        if (!HHMM.test(input[field])) throw new Error(`${field} must be HH:mm, e.g. "14:30". Got: ${input[field]}`);
        task[field] = input[field];
    }
    if (input.focusLevel != null) {
        const focus = Math.round(Number(input.focusLevel));
        if (!(focus >= 1 && focus <= 5)) throw new Error("focusLevel must be 1 to 5.");
        task.focusLevel = focus;
    }
    if (typeof input.notes === "string" && input.notes.trim()) task.notes = input.notes.trim();

    return task;
}

export async function addPerformedTask(userId, input = {}) {
    const task = buildPerformedTask(input);
    await ValidateSchema(TASK_REGISTER, { performedTasks: [task] }, { skipRequired: true });

    const { date: logDate, note } = await resolveLogDate(userId, input.date);
    const { start, end } = localDayRange(logDate);
    const within = { $gte: start, $lt: end };
    const db = await getDB();

    const existing = await db.collection(TASK_REGISTER).findOne({ userId, date: within });
    const already = (existing?.performedTasks ?? []).find(t => normaliseTitle(t.title) === normaliseTitle(task.title));
    if (already) {
        return { date: logDate, note, duplicate: true, task: already, day: existing };
    }

    const now = new Date();
    const dayName = new Date(`${logDate}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long" });

    // The duplicate check above gives the model its message; this $cond is what
    // actually holds. Two calls for the same title in one turn run in parallel,
    // both pass the read, and without it both would append.
    const titles = { $map: { input: { $ifNull: ["$performedTasks", []] }, in: { $toLower: { $trim: { input: "$$this.title" } } } } };
    const update = [{
        $set: {
            date: { $ifNull: ["$date", start] },
            day: { $ifNull: ["$day", dayName] },
            performedTasks: {
                $cond: [
                    { $in: [normaliseTitle(task.title), titles] },
                    "$performedTasks",
                    { $concatArrays: [{ $ifNull: ["$performedTasks", []] }, [{ $literal: task }]] },
                ],
            },
            createdAt: { $ifNull: ["$createdAt", now] },
            updatedAt: now,
        },
    }];

    const write = () => db.collection(TASK_REGISTER).findOneAndUpdate(
        { userId, date: within }, update, { upsert: true, returnDocument: "after" }
    );

    let doc;
    try {
        doc = await write();
    } catch (err) {
        if (err?.code !== DUPLICATE_KEY) throw err;
        doc = await write();
    }

    return { date: logDate, note, duplicate: false, task, day: doc };
}

export function describeTaskDay(doc) {
    const tasks = (doc?.performedTasks ?? []).map(t => `${t.title} (${t.status}, ${t.actualDurationMinutes} min)`);
    return tasks.length ? tasks.join(" · ") : "No work logged for this day.";
}
