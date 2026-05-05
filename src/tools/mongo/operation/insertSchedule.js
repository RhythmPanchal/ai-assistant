import { getDB } from "../mongoClient.js";
import { USER_SCHEDULE } from "../schema/userScheduleSchema.js";
import ValidateSchema from "../validateSchema.js";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
        return { success: false, error: "Invalid date format. Use ISO string like '2026-05-01'." };
    }

    const dayName = days[parsedDate.getDay()];

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
        day: dayName,
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
    return { success: true, insertedId: result.insertedId };
}
