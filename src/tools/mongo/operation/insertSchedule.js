import { getDB } from "../mongoClient.js";
import { USER_SCHEDULE } from "../schema/userScheduleSchema.js";
import ValidateSchema from "../validateSchema.js";
import { toIST, localDateOf } from "../dateUtils.js";
import { syncScheduleToCalendar } from "../../../connectors/gCalendar/syncScheduleToCalendar.js";

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

    // slotId is what updateSchedule and the calendar sync match on. Two slots
    // sharing one collapse into a single event and a single edit target, so the
    // second is silently lost. Checked here because ValidateSchema does not
    // enforce `required` inside array items — a missing slotId passes it too.
    const slotIds = slots.map(s => s?.slotId);
    const missing = slotIds.filter(id => typeof id !== "string" || !id.trim()).length;
    const repeated = [...new Set(slotIds.filter((id, i) => id && slotIds.indexOf(id) !== i))];
    if (missing || repeated.length) {
        return {
            success: false,
            error: (missing ? `${missing} slot(s) have no slotId. ` : "") +
                (repeated.length ? `slotId ${repeated.join(", ")} is used more than once. ` : "") +
                `Every slot needs its own: slot_1, slot_2, slot_3…`,
        };
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
        await ValidateSchema(USER_SCHEDULE, record);
    } catch (e) {
        return { success: false, error: `Schema validation failed: ${e.message}` };
    }

    const db = await getDB();
    const collection = db.collection(USER_SCHEDULE);

    // One schedule per user per day. Looked up here as well as enforced by the
    // unique index, because the index can be missing: on prod it failed to build
    // behind old duplicates, and a second lock-in on 2026-09-14 inserted a rival
    // schedule that every reader then ignored.
    const alreadyLocked = {
        success: false,
        error: `A schedule for ${date} is already locked in. To change it, read it with fetchRecord and ` +
            `call updateSchedule — insertSchedule only creates a day's first schedule.`,
    };
    const dayEnd = new Date(parsedDate.getTime() + 24 * 60 * 60 * 1000);
    if (await collection.findOne({ userId, date: { $gte: parsedDate, $lt: dayEnd } }, { projection: { _id: 1 } })) {
        return alreadyLocked;
    }

    let result;
    try {
        result = await collection.insertOne(record);
    } catch (err) {
        // The index closes the race the lookup above leaves open.
        if (err?.code === 11000) return alreadyLocked;
        throw err;
    }
    console.log("[insertSchedule] Created schedule for", date);

    // Background, not awaited — the reply should not wait on Google. Synced for
    // the day this schedule is FOR, which is not always the day it was written.
    syncScheduleToCalendar(userId, localDateOf(parsedDate)).catch(err =>
      console.error("[insertSchedule] Background calendar sync failed:", err)
    );

    return { success: true, insertedId: result.insertedId };
}
