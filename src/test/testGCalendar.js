import "dotenv/config";
import { createGCalendarEvents } from "../connectors/gCalendar/createGCalendarEvents.js";

const userId = 1136575387;

async function _testCreateSingleEvent() {
  const events = [
    {
      summary: "Morning Workout",
      description: "30 min run + stretching",
      start: { dateTime: "2026-06-25T07:00:00", timeZone: "Asia/Kolkata" },
      end:   { dateTime: "2026-06-25T07:30:00", timeZone: "Asia/Kolkata" },
    },
  ];

  const result = await createGCalendarEvents(userId, events);
  console.log("created:", result.created);
  console.log("failed: ", result.failed);
}

async function _testCreateMultipleEvents() {
  const events = [
    {
      summary: "Deep Work — OAuth connector",
      description: "Finish gCalendar OAuth flow",
      start: { dateTime: "2026-06-25T10:00:00", timeZone: "Asia/Kolkata" },
      end:   { dateTime: "2026-06-25T12:00:00", timeZone: "Asia/Kolkata" },
    },
    {
      summary: "Chalo - so jao",
      description: "Dekh lena thodi reels ab to kaleje to thandak mil gayi working fine",
      start: { dateTime: "2026-06-25T02:00:00", timeZone: "Asia/Kolkata" },
      end:   { dateTime: "2026-06-25T02:30:00", timeZone: "Asia/Kolkata" },
    },
    {
      summary: "Lunch Break",
      start: { dateTime: "2026-06-25T13:00:00", timeZone: "Asia/Kolkata" },
      end:   { dateTime: "2026-06-25T14:00:00", timeZone: "Asia/Kolkata" },
    },
    {
      summary: "Evening Walk",
      description: "30 min walk in the park",
      start: { dateTime: "2026-06-25T18:30:00", timeZone: "Asia/Kolkata" },
      end:   { dateTime: "2026-06-25T19:00:00", timeZone: "Asia/Kolkata" },
    },
  ];

  const result = await createGCalendarEvents(userId, events);
  console.log("created:", JSON.stringify(result.created, null, 2));
  console.log("failed: ", result.failed);
}

_testCreateMultipleEvents();
