/**
 * gCalendar OAuth provider config.
 *
 * Consumed by the generic OAuth core (src/tools/oauth/*). The OAuth code
 * never imports anything Google-specific — it only reads this config via
 * the provider registry.
 *
 * To add Notion later: drop a sibling `src/tools/notion/provider.js`
 * exporting an object of the same shape, then add one line to
 * src/tools/oauth/providerRegistry.js.
 */

import { sendMessage } from "../telegram/sendMessage.js";

export const GCALENDAR_APP = "gCalendar";

export const gCalendarProvider = {
  appName: GCALENDAR_APP,

  authUrl:  "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",

  clientIdEnv:     "GOOGLE_CLIENT_ID",
  clientSecretEnv: "GOOGLE_CLIENT_SECRET",

  // Narrow scope — we only ever touch the dedicated "Rasmalai" calendar we
  // create ourselves. Easier verification later than full `calendar.events`.
  scope: "https://www.googleapis.com/auth/calendar.app.created",

  // access_type=offline is REQUIRED to receive a refresh_token at all.
  // prompt=consent forces the consent screen every time so Google always
  // returns a refresh_token (without it, re-auth may skip consent and
  // omit refresh_token, breaking long-lived access).
  extraAuthParams: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true"
  },

  // Google takes client creds in the form body (not Basic auth).
  tokenAuthStyle: "body",

  hasRefreshToken:     true,
  requireRefreshToken: true,

  /**
   * Runs after tokens are persisted on the connector. Best-effort — errors
   * here are logged but don't fail the OAuth flow itself.
   *
   * Today: confirm in chat. Later (after calendar provisioning lands):
   *   - call calendars.insert to create a dedicated "Rasmalai" calendar
   *   - persist its id on connector.appData.calendarId
   */
  onConnected: async (userId, _tokens) => {
    try {
      await sendMessage(
        userId,
        "✅ Google Calendar connected. Your future schedules will sync here automatically."
      );
    } catch (err) {
      console.warn("[gCalendar.onConnected] confirmation message failed:", err.message);
    }
  }
};
