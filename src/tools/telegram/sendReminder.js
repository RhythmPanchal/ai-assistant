import { resolveAddress } from "../../identity/userManager.js";
import { sendMessage } from "./sendMessage.js";
import { formatReminder, reminderKeyboard } from "./reminderMessage.js";

/**
 * Deliver a fired reminder, with its Done / Missed buttons.
 *
 * A sibling of sendToUser rather than a flag on it. sendToUser is the generic
 * "say this to a person" path — the morning draft, the night opener, anything
 * the scheduler wants to push — and none of those should grow a pair of buttons
 * about task completion. Reminders are the one kind of pushed message that asks
 * a closed question, so they get their own actionType.
 *
 * It also means existing rows keep working untouched: every reminder written
 * before this change carries actionType "sendToUser" and still delivers, just
 * without buttons. There is no migration and no dual-purpose function.
 *
 * `jobId` is injected by executeTriggerJob from the row's own _id, not stored in
 * the payload — the id is not known when createReminders writes the row, and
 * denormalising it would mean a second write per reminder to put it there.
 *
 * @param {number}        userId
 * @param {string}        text    the reminder sentence
 * @param {string}        jobId   the triggerJob _id, for the buttons' callback data
 */
export async function sendReminder(userId, text, jobId) {
    if (userId === undefined || userId === null) {
        throw new Error(`[sendReminder] missing userId : ${userId}`);
    }

    const address = await resolveAddress(userId);
    if (!address) {
        // Same reasoning as sendToUser: a failed job is retried, and a missing
        // identity is usually a migration that has not run.
        throw new Error(`[sendReminder] no telegram identity for userId ${userId} — cannot deliver`);
    }

    const body = formatReminder(text);
    if (!body) {
        // reminderBody already refuses this at create time, so reaching here
        // means a hand-seeded or migrated row. Throwing would retry three times
        // and deliver nothing either way.
        console.warn(`[sendReminder] job ${jobId} has no reminder text — nothing to deliver`);
        return { ok: false, description: "empty reminder text" };
    }

    // No buttons without an id to attach them to: a tap has to name the row it
    // is answering. An id-less reminder still arrives, which is what matters.
    let options = {};
    if (jobId) {
        try {
            options = { reply_markup: reminderKeyboard(String(jobId)) };
        } catch (err) {
            console.warn(`[sendReminder] no buttons for job ${jobId}: ${err.message}`);
        }
    }

    return sendMessage(address, body, options);
}
