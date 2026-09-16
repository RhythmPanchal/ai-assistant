import { getDB } from "../../tools/mongo/mongoClient.js";
import { USER_SCHEDULE } from "../../tools/mongo/schema/userScheduleSchema.js";
import { toIST } from "../../tools/mongo/dateUtils.js";
import { getAccessToken } from "../oauth/getAccessToken.js";
import { createGCalendarEvents } from "./createGCalendarEvents.js";
import { planDaySync, listDayEvents, patchEvent, deleteEvent } from "./calendarEvents.js";

// Schedule times are IST wall-clock everywhere they are written.
const TIME_ZONE = "Asia/Kolkata";

/**
 * One calendar sync at a time per user.
 *
 * A sync lists the day and then writes the difference. Two running together
 * would both see "no event for slot_8" and both insert it — the duplicate this
 * layer exists to prevent. In-process only, matching the single-process
 * assumption the Telegram update queue already makes.
 */
const queues = new Map();

export function serialiseCalendarSync(userId, task) {
    const current = (queues.get(userId) ?? Promise.resolve())
        .catch(() => {})
        .then(task)
        .finally(() => {
            if (queues.get(userId) === current) queues.delete(userId);
        });
    queues.set(userId, current);
    return current;
}

/** Resolves once every sync queued for this user has settled, including ones queued while waiting. */
export async function whenCalendarSynced(userId) {
    let pending;
    while ((pending = queues.get(userId))) await pending.catch(() => {});
}

/**
 * Make one day of the user's Google Calendar match that day's schedule:
 * insert missing slots, patch changed ones in place, remove ours that no longer
 * belong. Events without Rasmalai's tag are never listed, so never touched.
 *
 * Idempotent — a second run with nothing changed makes no writes. Call through
 * serialiseCalendarSync; this function does not queue itself.
 *
 * @param {string} date "YYYY-MM-DD"
 */
export async function syncScheduleDay(userId, date) {
    const dayStart = toIST(date);
    const db = await getDB();
    const schedule = await db.collection(USER_SCHEDULE)
        .find({ userId, date: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 86400000) } })
        .sort({ _id: -1 })
        .limit(1)
        .next();

    // A missing schedule is not an instruction to clear the day. It is far more
    // likely a bug, and removing events on a guess cannot be undone.
    if (!schedule) {
        console.warn(`[calendarSync] no schedule for userId=${userId} ${date} — calendar left as it is`);
        return { date, skipped: true };
    }

    const token = await getAccessToken(userId, "gCalendar");
    const plan = planDaySync(date, schedule.slots, await listDayEvents(token, date), TIME_ZONE);
    const failed = [];

    let inserted = 0;
    if (plan.insert.length) {
        const result = await createGCalendarEvents(userId, plan.insert);
        inserted = result.created.length;
        for (const f of result.failed) failed.push(`insert "${plan.insert[f.index]?.summary}": ${f.error}`);
    }

    let patched = 0;
    for (const { id, body } of plan.patch) {
        const res = await patchEvent(token, id, body);
        if (res.ok) patched++;
        else failed.push(`patch ${id}: ${res.error}`);
    }

    let removed = 0;
    for (const id of plan.remove) {
        const res = await deleteEvent(token, id);
        if (res.ok) removed++;
        else failed.push(`delete ${id}: ${res.error}`);
    }

    console.log(
        `[calendarSync] userId=${userId} ${date} +${inserted} ~${patched} -${removed} =${plan.unchanged}` +
        (failed.length ? ` failed=${failed.length}` : "")
    );
    if (failed.length) console.error("[calendarSync] failures:", failed);

    return { date, inserted, patched, removed, unchanged: plan.unchanged, failed };
}
