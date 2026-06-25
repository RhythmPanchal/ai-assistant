import { getAccessToken } from "../oauth/getAccessToken.js";

const GCALENDAR_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_ID = "primary";

/**
 * Creates one or more events on the user's primary Google Calendar.
 *
 * Each event object follows the Google Calendar Events API shape:
 * {
 *   summary:     string                           -- required, event title
 *   start:       { dateTime: string, timeZone: string }  -- required (ISO 8601 datetime)
 *   end:         { dateTime: string, timeZone: string }  -- required
 *   description: string                           -- optional
 *   location:    string                           -- optional
 *   colorId:     string                           -- optional, "1"–"11"
 * }
 *
 * Returns { created: Event[], failed: { index, error }[] }
 */
export async function createGCalendarEvents(userId, events) {
  if (!userId) throw new Error("userId is required.");
  if (!Array.isArray(events) || events.length === 0) throw new Error("events must be a non-empty array.");

  const token = await getAccessToken(userId, "gCalendar");

  const results = await Promise.allSettled(
    events.map(event =>
      fetch(`${GCALENDAR_API}/calendars/${encodeURIComponent(CALENDAR_ID)}/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      }).then(res => res.json())
    )
  );

  const created = [];
  const failed = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value.error) {
        console.error(`[createGCalendarEvents] Event ${index} rejected by Google:`, result.value.error);
        failed.push({ index, error: result.value.error.message });
      } else {
        created.push(result.value);
      }
    } else {
      console.error(`[createGCalendarEvents] Event ${index} fetch failed:`, result.reason);
      failed.push({ index, error: result.reason?.message ?? "Unknown error" });
    }
  });

  return { created, failed };
}
