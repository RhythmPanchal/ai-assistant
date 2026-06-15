/**
 * Generic refresh-token handling for any provider in the registry.
 *
 *   refreshAccessToken(appName, refreshToken)
 *     - low-level: POST to provider's /token, return new access_token + expiry.
 *
 *   ensureFreshAccessToken(userId, appName)
 *     - high-level: read connector, refresh if needed, persist new token,
 *       return a token ready to use.
 *
 * Providers without refresh tokens (e.g. Notion — tokens never expire) are
 * supported: ensureFreshAccessToken short-circuits and just returns the
 * stored access_token; refreshAccessToken refuses to run for them.
 *
 * On invalid_grant (refresh token revoked / expired — common in Google
 * Testing mode where refresh tokens die after 7 days), the connector is
 * flipped to DISABLED so subsequent calls short-circuit. The caller can
 * then re-prompt for OAuth.
 */

import { getProvider } from "./providerRegistry.js";
import {
  getConnector,
  updateConnector,
  disableConnector
} from "../mongo/operation/connector.js";

// Refresh a little early so a token that's about to expire in-flight doesn't
// cause a 401 on the next provider API call.
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export async function refreshAccessToken(appName, refreshToken) {
  if (!refreshToken) throw new Error("[refreshAccessToken] refreshToken required");

  const provider = getProvider(appName);
  if (!provider.hasRefreshToken) {
    throw new Error(
      `[refreshAccessToken] ${appName} does not issue refresh tokens — nothing to refresh.`
    );
  }

  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(
      `[refreshAccessToken] ${provider.clientIdEnv}/${provider.clientSecretEnv} required for appName "${appName}"`
    );
  }

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const bodyParams = {
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  };

  if (provider.tokenAuthStyle === "basic") {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else {
    bodyParams.client_id = clientId;
    bodyParams.client_secret = clientSecret;
  }

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(bodyParams).toString()
  });
  const data = await res.json();

  if (!res.ok || data.error) {
    // Re-throw with the provider error code attached so callers can branch
    // on `err.providerError === "invalid_grant"` to trigger reconnect.
    const err = new Error(
      `[refreshAccessToken] ${appName} rejected refresh: ${data.error_description || data.error || res.statusText}`
    );
    err.providerError = data.error;
    throw err;
  }

  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in,
    scope: data.scope,
    // Some providers rotate refresh tokens; if so, persist the new one.
    rotatedRefreshToken: data.refresh_token || null
  };
}

/**
 * Read the user's connector for `appName` and return a valid access token,
 * calling refreshAccessToken under the hood if the cached one is missing /
 * expired / close to expiring.
 *
 * Returns:
 *   { accessToken, appData }            on success
 *   { needsReauth: true, reason }       if connector is missing / disabled /
 *                                       refresh failed irrecoverably.
 *
 * `appData` is the raw connector.appData object so app-specific callers
 * (e.g. gCalendar) can read fields they wrote during onConnected (the
 * dedicated calendarId, Notion's databaseId, etc.).
 */
export async function ensureFreshAccessToken(userId, appName) {
  const provider = getProvider(appName);

  const connector = await getConnector(userId, appName);
  if (!connector) return { needsReauth: true, reason: "connector_missing" };
  if (connector.appSupport !== "ENABLED") {
    return { needsReauth: true, reason: `state_${connector.appSupport}` };
  }

  // Providers without refresh tokens (Notion) — their access token never
  // expires, so just return it. Nothing to refresh.
  if (!provider.hasRefreshToken) {
    if (!connector.accessToken) {
      return { needsReauth: true, reason: "no_access_token" };
    }
    return {
      accessToken: connector.accessToken,
      appData: connector.appData || null
    };
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
      appData: connector.appData || null
    };
  }

  try {
    const fresh = await refreshAccessToken(appName, connector.refreshToken);
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
    await updateConnector(userId, appName, patch);
    return {
      accessToken: fresh.accessToken,
      appData: connector.appData || null
    };
  } catch (err) {
    // invalid_grant = refresh token is dead. Mark connector DISABLED and
    // let the caller decide whether to re-prompt for OAuth.
    if (err.providerError === "invalid_grant") {
      console.warn(
        `[ensureFreshAccessToken] invalid_grant for userId=${userId} appName=${appName} — disabling connector`
      );
      await disableConnector(userId, appName);
      return { needsReauth: true, reason: "invalid_grant" };
    }
    throw err;
  }
}
