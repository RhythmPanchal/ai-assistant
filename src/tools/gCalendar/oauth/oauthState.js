import crypto from "node:crypto";
import { getDB } from "../../mongo/mongoClient.js";
import { OAUTH_STATES } from "../../mongo/schema/oauthStatesSchema.js";

const STATE_TTL_MINUTES = 15;

let ttlIndexEnsured = false;

/**
 * Lazily create a TTL index on expiresAt so abandoned state tokens
 * disappear from the collection automatically. Runs once per process.
 */
async function ensureTTLIndex() {
  if (ttlIndexEnsured) return;
  const db = await getDB();
  // expireAfterSeconds: 0 = delete documents at the moment expiresAt is reached
  await db
    .collection(OAUTH_STATES)
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    .catch((err) => {
      console.warn("[oauthState] could not ensure TTL index:", err.message);
    });
  ttlIndexEnsured = true;
}

/**
 * Mint a fresh state token for (userId, appName) and persist it.
 *
 * @param {number} userId
 * @param {string} appName
 * @returns {Promise<string>} the token to embed in the OAuth `state` param
 */
export async function createOAuthState(userId, appName) {
  if (!userId || !appName) {
    throw new Error("[createOAuthState] userId and appName required");
  }
  await ensureTTLIndex();

  const token = crypto.randomBytes(24).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MINUTES * 60 * 1000);

  const db = await getDB();
  await db.collection(OAUTH_STATES).insertOne({
    token,
    userId,
    appName,
    expiresAt,
    createdAt: now
  });
  return token;
}

/**
 * Look up a state token without deleting it. Used by the /start handler,
 * which only needs to verify the token to know whom to redirect.
 *
 * @param {string} token
 */
export async function peekOAuthState(token) {
  if (!token) return null;
  const db = await getDB();
  const doc = await db.collection(OAUTH_STATES).findOne({ token });
  if (!doc) return null;
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
    return null;
  }
  return { userId: doc.userId, appName: doc.appName };
}

/**
 * Atomically consume a state token. Returns the (userId, appName) pair the
 * token was minted for, or null if the token is unknown / expired. The row
 * is deleted on success so a token cannot be replayed across two callbacks.
 *
 * @param {string} token
 */
export async function consumeOAuthState(token) {
  if (!token) return null;
  const db = await getDB();
  // findOneAndDelete is atomic — two parallel callbacks with the same
  // token can't both succeed.
  const result = await db.collection(OAUTH_STATES).findOneAndDelete({ token });
  const doc = result?.value ?? result;
  if (!doc) return null;
  if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
    return null;
  }
  return { userId: doc.userId, appName: doc.appName };
}
