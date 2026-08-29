import { getDB } from "../../tools/mongo/mongoClient.js";
import { CONNECTION } from "../../tools/mongo/schema/connectionSchema.js";
import { resolveProvider } from "./init.js";

// Refresh the token 5 minutes before it actually expires to avoid
// using a token that expires mid-request.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Did the provider say the grant itself is dead, as opposed to failing for a
 * reason that might not repeat?
 *
 * Deliberately narrow. `invalid_grant` is the one OAuth2 error that means "this
 * refresh token will never work again" — revoked by the user, expired (Google
 * expires refresh tokens after 7 days while an app is in Testing), or superseded.
 * Sibling errors like `invalid_client` mean OUR credentials are wrong, and
 * making the user re-authorise would not fix that, so they are left transient.
 */
export function isDeadGrant(body) {
  try {
    return JSON.parse(body)?.error === "invalid_grant";
  } catch {
    // Not JSON — a proxy error page or an empty body. Not a signal to throw the
    // user's connection away.
    return false;
  }
}

export async function getAccessToken(userId, appName) {
  const db = await getDB();
  const connection = await db.collection(CONNECTION).findOne({ userId, appName, status: "ACTIVE" });

  if (!connection) {
    throw new Error(`No active connection found for userId=${userId} appName=${appName}`);
  }
  if (!connection.access_token) {
    throw new Error(`No access token stored for userId=${userId} appName=${appName}`);
  }

  const isExpired = connection.expiresAt && connection.expiresAt - Date.now() < REFRESH_BUFFER_MS;

  if (!isExpired) {
    return connection.access_token;
  }

  if (!connection.refresh_token) {
    throw new Error(`Access token expired and no refresh token available for userId=${userId} appName=${appName}`);
  }

  const provider = await resolveProvider(appName);
  const refreshRequest = provider.buildRefreshRequest(connection.refresh_token);

  const response = await fetch(refreshRequest.url, {
    method: refreshRequest.method,
    headers: refreshRequest.headers,
    body: refreshRequest.body,
  });

  if (!response.ok) {
    const body = await response.text();

    if (isDeadGrant(body)) {
      // The grant is gone — revoked, expired, or superseded. No amount of
      // retrying brings it back; only the user re-authorising does. Leaving the
      // row ACTIVE meant the daily calendar sync threw every single day while
      // the connection still looked healthy, so nothing ever asked the user to
      // reconnect. Google's calendar sync was dead from 2026-08-16 to 2026-08-30
      // for exactly this reason.
      //
      // INACTIVE has been in the connection schema from the start and was never
      // written by anything. This is what it is for: distinct from DISABLED,
      // which means the user said no and must not be asked again.
      await db.collection(CONNECTION).updateOne(
        { userId, appName },
        {
          $set: {
            status: "INACTIVE",
            access_token: null,
            refresh_token: null,
            expiresAt: null,
            updatedAt: Date.now(),
          },
        }
      );

      throw new Error(
        `Connection for userId=${userId} appName=${appName} is no longer authorised ` +
        `and has been marked INACTIVE — the user needs to reconnect. Provider said: ${body}`
      );
    }

    // Anything else — 5xx, a rate limit, a network-level failure — is transient.
    // Downgrading the connection here would make a momentary blip cost the user
    // a re-authorisation.
    throw new Error(`Token refresh failed for userId=${userId} appName=${appName}: ${body}`);
  }

  const tokenData = await response.json();
  const now = Date.now();
  const expiresAt = tokenData.expires_in ? now + tokenData.expires_in * 1000 : null;

  await db.collection(CONNECTION).updateOne(
    { userId, appName },
    {
      $set: {
        access_token: tokenData.access_token,
        expiresAt,
        updatedAt: now,
      },
    }
  );

  return tokenData.access_token;
}
