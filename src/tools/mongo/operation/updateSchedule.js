import { getDB } from "../mongoClient.js";
import { USER_SCHEDULE } from "../schema/userScheduleSchema.js";
import ValidateSchema from "../validateSchema.js";
import { toIST } from "../dateUtils.js";
import { syncScheduleToCalendar } from "../../../connectors/gCalendar/syncScheduleToCalendar.js";

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EDITABLE = ["startTime", "endTime", "title", "category", "priority", "status", "notes", "taskRef"];

// Taken off the day. Left out of the overlap check, as they are off the calendar.
const OFF_DAY = new Set(["Skipped", "Rescheduled"]);

const fail = (error) => ({ success: false, error });

const describe = (s) =>
    `${s.slotId} ${s.startTime}-${s.endTime} ${s.title}${s.status && s.status !== "Planned" ? ` [${s.status}]` : ""}`;

function span(slot) {
    const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const start = toMin(slot.startTime);
    const end = toMin(slot.endTime);
    return [start, end <= start ? end + 1440 : end];
}

function findOverlaps(slots) {
    const on = slots.filter(s => !OFF_DAY.has(s.status));
    const out = [];
    for (let i = 0; i < on.length; i++) {
        for (let j = i + 1; j < on.length; j++) {
            const [a1, a2] = span(on[i]);
            const [b1, b2] = span(on[j]);
            if (a1 < b2 && b1 < a2) out.push(`${describe(on[i])} and ${describe(on[j])}`);
        }
    }
    return out;
}

const STATUSES = ["Planned", "InProgress", "Done", "Skipped", "Rescheduled"];
const PRIORITIES = ["Low", "Medium", "High"];

// Checked here rather than left to ValidateSchema, which reports a bad value
// inside a slot as "slots has invalid type" — nothing the model can act on.
function badField(slot, where) {
    for (const key of ["startTime", "endTime"]) {
        if (slot[key] !== undefined && !HH_MM.test(slot[key])) return `${where}.${key} "${slot[key]}" must be HH:mm, 24-hour`;
    }
    if (slot.status !== undefined && !STATUSES.includes(slot.status)) {
        return `${where}.status "${slot.status}" must be one of ${STATUSES.join(", ")}`;
    }
    if (slot.priority != null && !PRIORITIES.includes(slot.priority)) {
        return `${where}.priority "${slot.priority}" must be one of ${PRIORITIES.join(", ")}`;
    }
    if (slot.title !== undefined && (typeof slot.title !== "string" || !slot.title.trim())) {
        return `${where}.title must be a non-empty string`;
    }
    return null;
}

/**
 * Change a locked-in schedule: edit existing slots by slotId, add new ones.
 *
 * Never removes a slot. Dropping one is status "Skipped", which keeps the record
 * of what was planned and takes it off the calendar. All-or-nothing: an unknown
 * slotId or an invalid field refuses the whole change, so a half-applied edit
 * never reaches the calendar.
 *
 * @param {string} date "YYYY-MM-DD"
 * @param {{ update?: object[], add?: object[] }} changes
 */
export async function updateSchedule(userId, date, { update = [], add = [] } = {}) {
    if (!userId) return fail("userId is required.");
    if (typeof date !== "string" || !DATE_ONLY.test(date)) {
        return fail(`date must be "YYYY-MM-DD", got ${JSON.stringify(date)}.`);
    }
    if (!Array.isArray(update) || !Array.isArray(add)) return fail("update and add must be arrays.");
    if (!update.length && !add.length) return fail("Nothing to change — pass slots in update and/or add.");

    const dayStart = toIST(date);
    const db = await getDB();
    const collection = db.collection(USER_SCHEDULE);
    const schedule = await collection
        .find({ userId, date: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 86400000) } })
        .sort({ _id: -1 })
        .limit(1)
        .next();

    if (!schedule) {
        return fail(
            `No schedule is locked in for ${date}, so there is nothing to update. ` +
            `insertSchedule creates a day's first schedule, and only once the user has approved a whole plan.`
        );
    }

    const slots = schedule.slots.map(s => ({ ...s }));
    const byId = new Map(slots.map(s => [s.slotId, s]));

    // The slot list goes back with the refusal so the model can retry with real ids.
    const unknown = update.map(u => u?.slotId).filter(id => !byId.has(id));
    if (unknown.length) {
        return fail(
            `No slot ${unknown.map(id => JSON.stringify(id)).join(", ")} on ${date}. Nothing was changed. ` +
            `The slots are: ${slots.map(describe).join("; ")}`
        );
    }

    const updated = [];
    for (const [i, change] of update.entries()) {
        const problem = badField(change, `update[${i}]`);
        if (problem) return fail(`${problem}. Nothing was changed.`);
        const slot = byId.get(change.slotId);
        for (const key of EDITABLE) if (change[key] !== undefined) slot[key] = change[key];
        updated.push(slot.slotId);
    }

    // Assigned here, never taken from the model, and never reused: the calendar
    // keys events on slotId, so a recycled id would repoint someone else's event.
    let next = Math.max(0, ...slots.map(s => Number(/^slot_(\d+)$/.exec(s.slotId)?.[1] ?? 0))) + 1;
    const added = [];
    for (const [i, entry] of add.entries()) {
        if (!entry?.startTime || !entry?.endTime || !entry?.title) {
            return fail(`add[${i}] needs startTime, endTime and title. Nothing was changed.`);
        }
        const problem = badField(entry, `add[${i}]`);
        if (problem) return fail(`${problem}. Nothing was changed.`);
        const slot = {
            slotId: `slot_${next++}`,
            startTime: entry.startTime,
            endTime: entry.endTime,
            title: entry.title,
            category: entry.category ?? null,
            priority: entry.priority ?? null,
            status: entry.status ?? "Planned",
            notes: entry.notes ?? null,
            taskRef: entry.taskRef ?? null,
        };
        slots.push(slot);
        added.push(slot.slotId);
    }

    const empty = slots.find(s => s.startTime === s.endTime);
    if (empty) return fail(`${describe(empty)} starts and ends at the same time. Nothing was changed.`);

    slots.sort((a, b) => a.startTime.localeCompare(b.startTime));

    try {
        await ValidateSchema(USER_SCHEDULE, {
            userId,
            date: schedule.date,
            day: schedule.day,
            slots,
            summary: schedule.summary ?? null,
            motivationalNote: schedule.motivationalNote ?? null,
        });
    } catch (e) {
        return fail(`${e.message}. Nothing was changed.`);
    }

    await collection.updateOne({ _id: schedule._id, userId }, { $set: { slots, updatedAt: new Date() } });

    // Background, like insertSchedule. An edit does not re-offer the connection.
    syncScheduleToCalendar(userId, date, { promptIfDisconnected: false }).catch(err =>
        console.error("[updateSchedule] Background calendar sync failed:", err)
    );

    return { success: true, date, updated, added, overlaps: findOverlaps(slots), slots };
}
