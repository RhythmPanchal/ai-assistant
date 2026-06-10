import { getDB } from "../mongoClient.js";
import { CONNECTORS } from "../schema/connectorsSchema.js";

/**
 * Fetch a single connector for (userId, appName). Returns null if missing.
 *
 * @param {number} userId
 * @param {string} appName  e.g. "gCalendar"
 * @returns {Promise<object|null>}
 */
export async function getConnector(userId, appName) {
  if (!userId || !appName) return null;
  const db = await getDB();
  return db.collection(CONNECTORS).findOne({ userId, appName });
}

/**
 * Insert a PENDING connector row if none exists for (userId, appName).
 * Returns the existing or freshly-inserted row. Used the first time we
 * realize we need a particular integration for a user.
 *
 * @param {number} userId
 * @param {string} appName
 * @returns {Promise<object>}
 */
export async function ensurePendingConnector(userId, appName) {
  if (!userId || !appName) {
    throw new Error("[ensurePendingConnector] userId and appName are required");
  }
  const db = await getDB();
  const col = db.collection(CONNECTORS);

  const existing = await col.findOne({ userId, appName });
  if (existing) return existing;

  const doc = {
    userId,
    appName,
    appSupport: "PENDING",
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    scope: null,
    appData: null,
    connectedAt: null,
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: null
  };
  await col.insertOne(doc);
  return doc;
}

/**
 * Patch arbitrary fields on a connector. updatedAt is always bumped.
 * Returns the updated document.
 *
 * @param {number} userId
 * @param {string} appName
 * @param {object} patch
 * @returns {Promise<object|null>}
 */
export async function updateConnector(userId, appName, patch) {
  if (!userId || !appName) {
    throw new Error("[updateConnector] userId and appName are required");
  }
  const db = await getDB();
  const col = db.collection(CONNECTORS);
  const result = await col.findOneAndUpdate(
    { userId, appName },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return result.value || result; // driver shape differs across versions
}

/**
 * Convenience: mark connector DISABLED. Triggered by the user's
 * "do not ask" button click, or by an irrecoverable refresh failure.
 */
export async function disableConnector(userId, appName) {
  return updateConnector(userId, appName, {
    appSupport: "DISABLED",
    disabledAt: new Date()
  });
}

/**
 * Convenience: write a fresh token bundle and flip the connector to ENABLED.
 * Called by the OAuth callback after a successful code exchange.
 *
 * @param {number} userId
 * @param {string} appName
 * @param {object} tokens  { accessToken, refreshToken, expiresInSeconds, scope }
 */
export async function enableConnectorWithTokens(userId, appName, tokens) {
  const { accessToken, refreshToken, expiresInSeconds, scope } = tokens;
  const expiresAt = expiresInSeconds
    ? new Date(Date.now() + expiresInSeconds * 1000)
    : null;

  return updateConnector(userId, appName, {
    appSupport: "ENABLED",
    accessToken: accessToken || null,
    refreshToken: refreshToken || null,
    accessTokenExpiresAt: expiresAt,
    scope: scope || null,
    connectedAt: new Date()
  });
}
