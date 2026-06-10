import { getDB } from "../mongoClient.js";
import { USERS } from "../schema/usersSchema.js";

/**
 * Fetch a single user document by userId (Telegram chat id).
 * Returns null if no user is registered yet.
 *
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
export async function getUserByUserId(userId) {
  if (!userId) return null;
  const db = await getDB();
  return db.collection(USERS).findOne({ userId });
}

/**
 * Insert a user if one does not exist for this userId, otherwise return the
 * existing record. Used at first Telegram contact so we always have a row to
 * hang connectors / preferences off.
 *
 * @param {number} userId
 * @param {string} userName
 * @returns {Promise<object>}
 */
export async function ensureUser(userId, userName) {
  if (!userId) throw new Error("[ensureUser] userId is required");
  const db = await getDB();
  const col = db.collection(USERS);

  const existing = await col.findOne({ userId });
  if (existing) return existing;

  const doc = {
    userId,
    userName: userName || `user_${userId}`,
    userContext: null,
    createdAt: new Date(),
    updatedAt: null
  };
  await col.insertOne(doc);
  return doc;
}
