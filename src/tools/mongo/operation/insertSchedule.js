import { getDB } from "../mongoClient.js";
import { USER_SCHEDULE } from "../schema/userScheduleSchema.js";
import ValidateSchema from "../validateSchema.js";
import { toIST } from "../dateUtils.js";
import { connectorButton } from "../../telegram/connectorPromptButton.js";
import { insertTodaySchedule } from "../../../connectors/gCalendar/insertTodaySchedule.js";

/**
 * Insert a new daily schedule for the user.
 * Creates a single schedule document for the given userId + date.
 * Will fail if a schedule already exists for that userId + date (unique index).
 *
 * @param {number}  userId
 * @param {string}  date              – ISO date string e.g. "2026-05-01"
 * @param {Array}   slots             – full slot objects
 * @param {string}  [summary]
 * @param {string}  [motivationalNote]
 */
export async function insertSchedule(userId, date, slots, summary, motivationalNote) {
    if (!userId) {
        return { success: false, error: "userId is required." };
    }
    if (!date) {
        return { success: false, error: "date is required." };
    }
    if (!Array.isArray(slots) || slots.length === 0) {
        return { success: false, error: "slots must be a non-empty array." };
    }

    const parsedDate = toIST(date);
    if (!parsedDate || isNaN(parsedDate.getTime())) {
        return { success: false, error: "Invalid date format. Use ISO string like '2026-05-01'." };
    }

    // Day name from the IST wall-clock day, not the host's local day —
    // otherwise a UTC server would label IST-midnight as the previous day.
    const istDayName = parsedDate.toLocaleDateString("en-US", {
        timeZone: "Asia/Kolkata",
        weekday: "long",
    });

    // Enrich slots with defaults
    const enrichedSlots = slots.map(slot => ({
        ...slot,
        status: slot.status || "Planned",
        category: slot.category || null,
        taskRef: slot.taskRef || null,
        priority: slot.priority || null,
        notes: slot.notes || null,
    }));

    // Sort by startTime
    enrichedSlots.sort((a, b) => a.startTime.localeCompare(b.startTime));

    const record = {
        userId,
        date: parsedDate,
        day: istDayName,
        slots: enrichedSlots,
        summary: summary || null,
        motivationalNote: motivationalNote || null
    };

    // Validate against schema
    try {
        ValidateSchema(USER_SCHEDULE, record);
    } catch (e) {
        return { success: false, error: `Schema validation failed: ${e.message}` };
    }

    const db = await getDB();
    const collection = db.collection(USER_SCHEDULE);

    const result = await collection.insertOne(record);
    console.log("[insertSchedule] Created schedule for", date);

    // Fire calendar sync in the background — no await so the agent response
    // is not delayed. Errors are logged but never surface to the caller.
    syncScheduleToCalendar(userId).catch(err =>
      console.error("[insertSchedule] Background calendar sync failed:", err)
    );

    return { success: true, insertedId: result.insertedId };
}

const GCALENDAR_CONNECT_TEXT =
  "📅 Would you like Rasmalai to manage your Google Calendar? " +
  "By connecting, your daily schedule will be automatically uploaded to your Google Calendar. " +
  "Tap *Connect* to authorise, or *Do not ask again* if you prefer to manage it yourself.";

async function syncScheduleToCalendar(userId) {
    const db = await getDB();
    const connection = await db.collection("connection").findOne({ userId, appName: "gCalendar" });
    const status = connection?.status;

    if (status === "DISABLED") {
        return;
    }

    if (!connection || status === "PENDING") {
        const buttonResult = await connectorButton(userId, "gCalendar", GCALENDAR_CONNECT_TEXT);
        const telegramMessageId = buttonResult?.result?.message_id ?? null;

        // Store the Telegram message ID so the OAuth callback can edit this
        // message later (e.g. to remove the inline keyboard after connect/dismiss).
        if (telegramMessageId) {
            await db.collection("connection").updateOne(
                { userId, appName: "gCalendar" },
                { $set: { telegramMessageId, updatedAt: Date.now() } }
            );
        }
        // Sync happens via insertTodaySchedule triggered from the OAuth callback,
        // not here — no wait, no re-check needed.
        return;
    }

    if (status === "ACTIVE") {
        await insertTodaySchedule(userId);
    }
}
