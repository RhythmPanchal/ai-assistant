import { ObjectId } from "mongodb";
import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";

/**
 * Record a Done / Missed tap against one reminder.
 *
 * Raw driver, like cancelReminder — this writes two bookkeeping fields on a row
 * the user already owns, and routing it through updateRecords would mean the
 * model-facing validation path for something no model can reach.
 *
 * THE FILTER CARRIES userId. The jobId arrives inside callback_data, which
 * round-trips through the Telegram client and is therefore attacker-supplied:
 * anyone who can press a button can send any id they like. Scoping the update
 * by the userId resolved from `from.id` means a forged id matches nothing
 * instead of writing to someone else's reminder. Same rule as §6a — identity is
 * part of the filter, not a check afterwards.
 *
 * @param {number} userId   resolved from callback_query.from.id, never from the data
 * @param {string} jobId    24-hex triggerJob _id
 * @param {"done"|"missed"} verdict
 */
export async function recordReminderResponse(userId, jobId, verdict) {
    if (userId === undefined || userId === null) {
        throw new Error(`[recordReminderResponse] missing userId : ${userId}`);
    }
    if (!/^[0-9a-f]{24}$/i.test(String(jobId))) {
        // parseReminderCallback already refuses this shape; belt and braces,
        // because ObjectId.createFromHexString throws on anything else.
        return { success: false, message: "That reminder reference is not valid." };
    }

    const status = verdict === "done" ? "completed" : "missed";
    const db = await getDB();

    const job = await db.collection(TRIGGER_JOB).findOne(
        { _id: ObjectId.createFromHexString(String(jobId)), userId },
        { projection: { title: 1, payload: 1, lastExecutedAt: 1, reminderResponse: 1 } }
    );

    if (!job) {
        // Either a forged id or a reminder that has since been deleted. The
        // user sees the same thing in both cases, deliberately — a message that
        // distinguishes them is a probe oracle.
        console.warn(`[recordReminderResponse] no reminder ${jobId} for userId ${userId}`);
        return { success: false, message: "I can't find that reminder any more." };
    }

    // The firing this answers. lastExecutedAt is stamped by executeTriggerJob
    // on success, so at tap time it is the most recent firing — which is the one
    // the button they tapped belongs to. If the reminder fired AGAIN before they
    // tapped (a daily reminder answered 25 hours late) the answer lands on the
    // newer firing; that is a deliberate simplification, and the older one then
    // reads as never answered, which is true.
    const forExecutionAt = job.lastExecutedAt ?? new Date();

    const already = job.reminderResponse;
    const isRepeat = already?.status
        && already.forExecutionAt?.getTime?.() === forExecutionAt.getTime?.();

    await db.collection(TRIGGER_JOB).updateOne(
        { _id: job._id, userId },
        {
            $set: {
                reminderResponse: { status, respondedAt: new Date(), forExecutionAt },
                updatedAt: new Date(),
            },
        }
    );

    return {
        success: true,
        status,
        changed: !isRepeat || already.status !== status,
        previousStatus: already?.status ?? null,
        title: job.title,
        text: job.payload?.text ?? "",
    };
}
