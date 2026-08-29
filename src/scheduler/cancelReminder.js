import { ObjectId } from "mongodb";
import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";

/**
 * What this tool is allowed to stop.
 *
 * triggerJob holds two different kinds of row: reminders the user asked for,
 * and the scheduled routines the system runs for itself. They are only
 * distinguishable by actionType, and "cancel my morning reminder" is an
 * entirely natural way to refer to either one — so without this the agent
 * could silently switch off the good-morning routine while believing it had
 * cancelled a reminder.
 *
 * sendMessage is here alongside sendToUser because rows written before the
 * identity split still carry it with a baked-in chatId, and those are exactly
 * the old reminders most likely to need cancelling.
 */
const CANCELLABLE_ACTION_TYPES = new Set(["sendToUser", "sendMessage"]);

/** Exported so the boundary can be tested without standing up a database. */
export function isCancellableAction(actionType) {
    return CANCELLABLE_ACTION_TYPES.has(actionType);
}

/**
 * Cancel one reminder by _id.
 *
 * Cancelling sets status rather than removing the row — the same choice
 * taskCalendar makes, and the reason "cancelled" is in the triggerJob status
 * enum. The row is the record that the reminder existed and was called off.
 *
 * The caller must pass an _id that came from a real fetchRecord response.
 * userId is part of the filter rather than a check afterwards, so a wrong _id
 * cancels nothing instead of reaching another user's row.
 *
 * @param {string} id      24-char hex _id from a fetchRecord result
 * @param {number} userId  supplied by the tool registry from the request context
 * @param {string} reason  why — recorded in the log line, not the database
 */
export async function cancelReminder(id, userId, reason) {
    if (userId === undefined || userId === null) {
        throw new Error("userId is required to cancel a reminder.");
    }

    let objectId;
    try {
        objectId = ObjectId.createFromHexString(String(id));
    } catch {
        throw new Error(
            `Invalid id: "${id}" is not a 24-character hex _id. ` +
            `Call fetchRecord on triggerJob first and use the exact _id it returned.`
        );
    }

    const db = await getDB();
    const collection = db.collection(TRIGGER_JOB);

    // Read before writing, so a refusal can say which of several quite different
    // things went wrong. A bare updateOne that matched nothing would report the
    // same "not found" whether the id was wrong, the reminder had already fired,
    // or the row belongs to the daily routine.
    const job = await collection.findOne({ _id: objectId, userId });

    if (!job) {
        throw new Error(
            `No reminder ${id} belongs to this user. Call fetchRecord on triggerJob ` +
            `and cancel one of the _ids it returns.`
        );
    }

    if (!isCancellableAction(job.actionType)) {
        throw new Error(
            `"${job.title}" is a scheduled routine (${job.actionType}), not a reminder, ` +
            `so it cannot be cancelled here. Tell the user what it is and leave it running.`
        );
    }

    if (job.status === "cancelled") {
        return {
            success: true,
            alreadyCancelled: true,
            id,
            title: job.title,
            message: `"${job.title}" was already cancelled — nothing to do.`,
        };
    }

    if (job.status !== "active") {
        // "processing" is a job mid-flight: executeTriggerJob has claimed it and
        // will write its own terminal status when it finishes, which would land
        // on top of anything set here. Everything else has already run its course.
        const detail = job.status === "processing"
            ? "it is firing right now — try again in a few seconds"
            : `it is already ${job.status} and will not fire again`;
        throw new Error(`Cannot cancel "${job.title}": ${detail}.`);
    }

    const result = await collection.findOneAndUpdate(
        { _id: objectId, userId, status: "active" },
        { $set: { status: "cancelled", nextExecutionAt: null, updatedAt: new Date() } },
        { returnDocument: "after" }
    );

    if (!result) {
        // Lost a race with the executor between the read above and this write.
        throw new Error(`Cannot cancel "${job.title}": it started firing just now — try again in a few seconds.`);
    }

    console.log(
        `[cancelReminder] userId=${userId} cancelled ${id} ("${job.title}", ` +
        `${job.recurring ? `cron ${job.cronPattern}` : "one-time"}). Reason: ${reason ?? "not given"}`
    );

    return {
        success: true,
        id,
        title: job.title,
        recurring: !!job.recurring,
        cronPattern: job.cronPattern ?? null,
        // The fire time it will now never reach. The agent quotes this back so
        // the user can catch a wrong pick immediately.
        cancelledBefore: job.nextExecutionAt ?? null,
    };
}
