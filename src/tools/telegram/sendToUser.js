import { resolveAddress } from "../../agent/userManager.js";
import { sendMessage } from "./sendMessage.js";

/**
 * Send to a user by IDENTITY, resolving the channel address at delivery time.
 *
 * sendMessage takes an address and knows nothing about users; this is the layer
 * above it. Scheduler-only, like sendMessage — the agent replies through the
 * turn's return value, not by dispatching messages at people.
 *
 * Resolution happens now rather than when the job row was written, so a reminder
 * created in March still lands if the user's chat changed in June. That is the
 * whole reason triggerJob payloads carry a userId instead of a baked-in chatId.
 */
export async function sendToUser(userId, text) {
    if (userId === undefined || userId === null) {
        throw new Error(`[sendToUser] missing userId : ${userId}`);
    }

    const address = await resolveAddress(userId);
    if (!address) {
        // Throwing rather than returning quietly: executeTriggerJob treats this
        // as a failed job and retries, which is right — a missing identity is
        // usually a migration that has not run, not a permanent condition.
        throw new Error(`[sendToUser] no telegram identity for userId ${userId} — cannot deliver`);
    }

    return sendMessage(address, text);
}
