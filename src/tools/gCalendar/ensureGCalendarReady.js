/**
 * Decide what to do about a user's gCalendar connector at schedule time.
 *
 * Called by insertSchedule after the userSchedule document is written.
 * Branches:
 *
 *   no row OR PENDING -> ensure a PENDING row exists, prompt user with
 *                        Connect / Do not ask buttons. Return { status:
 *                        "prompted" } so the caller knows nothing more
 *                        happens this turn.
 *
 *   ENABLED           -> refresh the access token if it's stale, return
 *                        { status: "ready", accessToken, calendarId }.
 *                        If refresh fails irrecoverably (invalid_grant in
 *                        the refresh helper auto-DISABLES the connector),
 *                        return { status: "needs_reauth" } and the caller
 *                        skips event creation this turn — the next
 *                        insertSchedule will re-prompt.
 *
 *   DISABLED          -> silent skip, return { status: "skipped" }.
 *
 * Event creation itself is deliberately NOT done here yet — the user said
 * "for now later will add events". This function just guards the state
 * machine and returns a usable token when one is available.
 */

import {
  getConnector,
  ensurePendingConnector
} from "../mongo/operation/connector.js";
import { ensureFreshAccessToken } from "./refresh.js";
import { sendConnectorPrompt } from "./sendConnectorPrompt.js";

const GCALENDAR_APP = "gCalendar";

export async function ensureGCalendarReady(userId) {
  if (!userId) {
    return { status: "skipped", reason: "no_userId" };
  }

  let connector = await getConnector(userId, GCALENDAR_APP);

  // First-time path: no row yet -> create PENDING row + prompt.
  if (!connector) {
    connector = await ensurePendingConnector(userId, GCALENDAR_APP);
    await sendConnectorPrompt(userId, GCALENDAR_APP);
    return { status: "prompted" };
  }

  if (connector.appSupport === "PENDING") {
    // Row already exists in PENDING state — could be from a previous prompt
    // the user never answered. Re-prompt so they can act now.
    await sendConnectorPrompt(userId, GCALENDAR_APP);
    return { status: "prompted" };
  }

  if (connector.appSupport === "DISABLED") {
    return { status: "skipped", reason: "user_disabled" };
  }

  // ENABLED -> refresh the access token if needed.
  const fresh = await ensureFreshAccessToken(userId);
  if (fresh.needsReauth) {
    // refresh.js already flipped the connector to DISABLED on invalid_grant.
    // For any other reason (e.g. missing refresh_token somehow), the
    // appSupport state already reflects the actual situation.
    return { status: "needs_reauth", reason: fresh.reason };
  }

  return {
    status: "ready",
    accessToken: fresh.accessToken,
    calendarId: fresh.calendarId
  };
}
