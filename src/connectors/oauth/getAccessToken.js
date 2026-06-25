import { getDB } from "../../tools/mongo/mongoClient.js";
import { resolveProvider } from "./init.js";

// Refresh the token 5 minutes before it actually expires to avoid
// using a token that expires mid-request.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function getAccessToken(userId, appName) {
  const db = await getDB();
  const connection = await db.collection("connection").findOne({ userId, appName, status: "ACTIVE" });

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
    throw new Error(`Token refresh failed for userId=${userId} appName=${appName}: ${body}`);
  }

  const tokenData = await response.json();
  const now = Date.now();
  const expiresAt = tokenData.expires_in ? now + tokenData.expires_in * 1000 : null;

  await db.collection("connection").updateOne(
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
