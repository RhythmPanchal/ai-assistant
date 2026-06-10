import { getDB } from "../mongoClient.js";
import { USER_SCHEDULE } from "../schema/userScheduleSchema.js";
import ValidateSchema from "../validateSchema.js";
import { toIST } from "../dateUtils.js";
import { ensureGCalendarReady } from "../../gCalendar/ensureGCalendarReady.js";

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

    // Kick the gCalendar connector check off the critical path. We don't
    // await it — any failure here must not roll back or surface to the
    // schedule insert, which is the actual product write. The handler
    // itself decides whether to prompt, refresh, or skip silently based
    // on the connector's appSupport state.
    ensureGCalendarReady(userId)
      .then((res) => {
        console.log("[insertSchedule] gCalendar check:", res.status);
      })
      .catch((err) => {
        console.error("[insertSchedule] gCalendar check failed:", err);
      });

    return { success: true, insertedId: result.insertedId };
}
