/**
 * Refresh logic for the gCalendar connector.
 *
 *   refreshAccessToken(refreshToken)   — low-level: POST to Google /token,
 *                                        return new access_token + expiry.
 *
 *   ensureFreshAccessToken(userId)     — high-level: read connector, refresh
 *                                        if needed, persist new token,
 *                                        return a token ready to use.
 *
 * On invalid_grant from Google (refresh token revoked / expired — common in
 * Testing publishing status where refresh tokens die after 7 days), the
 * connector is flipped to DISABLED so subsequent calls short-circuit.
 * The caller can then re-prompt for OAuth.
 */

import {
  getConnector,
  updateConnector,
  disableConnector
} from "../mongo/operation/connector.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCALENDAR_APP = "gCalendar";

// Refresh a little early so a token that's about to expire in-flight doesn't
// cause a 401 on the next Calendar API call.
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export async function refreshAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("[refreshAccessToken] GOOGLE_CLIENT_ID/SECRET required");
  }
  if (!refreshToken) {
    throw new Error("[refreshAccessToken] refreshToken required");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const data = await res.json();

  if (!res.ok || data.error) {
    // Re-throw with the original error code attached so callers can branch
    // on `err.googleError === "invalid_grant"` to trigger reconnect.
    const err = new Error(
      `[refreshAccessToken] Google rejected refresh: ${data.error_description || data.error || res.statusText}`
    );
    err.googleError = data.error;
    throw err;
  }

  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in,
    scope: data.scope,
    // Google occasionally rotates refresh tokens; if so, persist the new one.
    rotatedRefreshToken: data.refresh_token || null
  };
}

/**
 * Read the user's gCalendar connector and return a valid access token, calling
 * refreshAccessToken under the hood if the cached one is missing / expired /
 * close to expiring.
 *
 * Returns:
 *   { accessToken, calendarId }                  on success
 *   { needsReauth: true, reason }                if connector is missing /
 *                                                disabled / refresh failed
 *                                                irrecoverably.
 */
export async function ensureFreshAccessToken(userId) {
  const connector = await getConnector(userId, GCALENDAR_APP);
  if (!connector) {
    return { needsReauth: true, reason: "connector_missing" };
  }
  if (connector.appSupport !== "ENABLED") {
    return { needsReauth: true, reason: `state_${connector.appSupport}` };
  }
  if (!connector.refreshToken) {
    return { needsReauth: true, reason: "no_refresh_token" };
  }

  const expiresAt = connector.accessTokenExpiresAt?.getTime?.() ?? 0;
  const stillValid =
    connector.accessToken && expiresAt - Date.now() > REFRESH_LEEWAY_MS;

  if (stillValid) {
    return {
      accessToken: connector.accessToken,
      calendarId: connector.appData?.calendarId ?? null
    };
  }

  try {
    const fresh = await refreshAccessToken(connector.refreshToken);
    const patch = {
      accessToken: fresh.accessToken,
      accessTokenExpiresAt: fresh.expiresInSeconds
        ? new Date(Date.now() + fresh.expiresInSeconds * 1000)
        : null,
      scope: fresh.scope || connector.scope
    };
    if (fresh.rotatedRefreshToken) {
      patch.refreshToken = fresh.rotatedRefreshToken;
    }
    await updateConnector(userId, GCALENDAR_APP, patch);
    return {
      accessToken: fresh.accessToken,
      calendarId: connector.appData?.calendarId ?? null
    };
  } catch (err) {
    // invalid_grant = refresh token is dead. Mark connector DISABLED and
    // let the caller decide whether to re-prompt for OAuth.
    if (err.googleError === "invalid_grant") {
      console.warn(
        `[ensureFreshAccessToken] invalid_grant for userId=${userId} — disabling connector`
      );
      await disableConnector(userId, GCALENDAR_APP);
      return { needsReauth: true, reason: "invalid_grant" };
    }
    throw err;
  }
}
