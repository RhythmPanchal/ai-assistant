import { getDB } from "../../tools/mongo/mongoClient.js";
import { toIST } from "../../tools/mongo/dateUtils.js";
import { createGCalendarEvents } from "./createGCalendarEvents.js";

export async function insertTodaySchedule(userId) {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // "YYYY-MM-DD"
  const dayStart = toIST(todayStr);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const db = await getDB();
  const schedule = await db.collection("userSchedule").findOne({
    userId,
    date: { $gte: dayStart, $lt: dayEnd },
  });

  if (!schedule) {
    console.warn(`[insertTodaySchedule] No schedule found for userId=${userId} date=${todayStr}`);
    return;
  }

  // Use IST wall-clock date for event datetimes, not UTC slice — a UTC server
  // would produce the wrong date for IST-midnight-stored dates.
  const dateStr = schedule.date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const timeZone = "Asia/Kolkata";

  const events = schedule.slots.map(slot => ({
    summary: slot.title,
    ...(slot.notes && { description: slot.notes }),
    start: { dateTime: `${dateStr}T${slot.startTime}:00`, timeZone },
    end:   { dateTime: `${dateStr}T${slot.endTime}:00`,   timeZone },
  }));

  const { created, failed } = await createGCalendarEvents(userId, events);
  console.log(`[insertTodaySchedule] userId=${userId} created=${created.length} failed=${failed.length}`);
  if (failed.length > 0) {
    console.error(`[insertTodaySchedule] Failed events:`, failed);
  }
}
