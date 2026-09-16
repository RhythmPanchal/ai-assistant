import { getDB } from "../../tools/mongo/mongoClient.js";
import { connectorButton } from "../../tools/telegram/connectorPromptButton.js";
import { serialiseCalendarSync, syncScheduleDay } from "./syncScheduleDay.js";

const GCALENDAR_CONNECT_TEXT =
  "📅 Would you like Rasmalai to manage your Google Calendar? " +
  "By connecting, your daily schedule will be automatically uploaded to your Google Calendar. " +
  "Tap *Connect* to authorise, or *Do not ask again* if you prefer to manage it yourself.";

// A connection that Google has stopped honouring. Worth its own copy: the user
// already agreed once, so "would you like to connect?" reads as though nothing
// had ever been set up, and gives no hint why events quietly stopped appearing.
const GCALENDAR_RECONNECT_TEXT =
  "📅 Google Calendar has disconnected — Google stopped accepting Rasmalai's access, " +
  "so your schedule hasn't been syncing. Tap *Connect* to re-authorise, " +
  "or *Do not ask again* to stop the calendar sync for good.";

async function promptConnect(db, userId, status) {
    const buttonResult = await connectorButton(
        userId,
        "gCalendar",
        status === "INACTIVE" ? GCALENDAR_RECONNECT_TEXT : GCALENDAR_CONNECT_TEXT
    );
    const telegramMessageId = buttonResult?.result?.message_id ?? null;

    // Store the Telegram message ID so the OAuth callback can edit this
    // message later (e.g. to remove the inline keyboard after connect/dismiss).
    if (telegramMessageId) {
        await db.collection("connection").updateOne(
            { userId, appName: "gCalendar" },
            { $set: { telegramMessageId, updatedAt: Date.now() } }
        );
    }
}

/**
 * Bring the user's Google Calendar in line with one day's schedule, or ask them
 * to connect when there is nothing to sync to. Queued behind any other calendar
 * sync for the same user.
 *
 * @param {string}  date "YYYY-MM-DD" — the day the schedule is FOR.
 * @param {boolean} [options.promptIfDisconnected] Off for edits. Offering the
 *        connection when a day is locked in is fine; offering it again on every
 *        change is nagging. A grant that dies DURING the sync still prompts.
 */
export function syncScheduleToCalendar(userId, date, { promptIfDisconnected = true } = {}) {
    return serialiseCalendarSync(userId, () => run(userId, date, promptIfDisconnected));
}

async function run(userId, date, promptIfDisconnected) {
    const db = await getDB();
    const connection = await db.collection("connection").findOne({ userId, appName: "gCalendar" });
    const status = connection?.status;

    if (status === "DISABLED") {
        return;
    }

    // INACTIVE means getAccessToken saw the grant die. Prompting is the whole
    // point of that status — without this branch the row simply stops being
    // ACTIVE and the sync goes silent, which is the failure it was added to fix.
    if (!connection || status === "PENDING" || status === "INACTIVE") {
        // Once they connect, the OAuth callback syncs the day itself.
        if (promptIfDisconnected) await promptConnect(db, userId, status);
        return;
    }

    if (status === "ACTIVE") {
        try {
            await syncScheduleDay(userId, date);
        } catch (err) {
            // getAccessToken downgrades the row to INACTIVE when Google refuses
            // the grant. Asking again on the spot matters: schedules are written
            // roughly once a day, so waiting for the next call to notice the new
            // status would cost another silent day.
            //
            // Re-read the row rather than pattern-matching the error — the
            // prompt should follow the state that was actually recorded, and a
            // failure for any other reason must not nag the user to reconnect.
            const after = await db.collection("connection").findOne({ userId, appName: "gCalendar" });
            if (after?.status !== "INACTIVE") throw err;

            console.warn(`[syncScheduleToCalendar] gCalendar went INACTIVE for userId=${userId}; asking to reconnect.`);
            await promptConnect(db, userId, "INACTIVE");
        }
    }
}
