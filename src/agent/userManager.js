import { getDB } from "../tools/mongo/mongoClient.js";
import { USERS } from "../tools/mongo/schema/usersSchema.js";
import { USER_IDENTITY } from "../tools/mongo/schema/userIdentitySchema.js";
import { COUNTERS, USER_ID_SEQUENCE } from "../tools/mongo/schema/countersSchema.js";

const USERS_COLLECTION = USERS;

const DEFAULT_TIMEZONE = "Asia/Kolkata";

// The original single user. Still the fallback so routines keep firing before
// anyone is onboarded into the users collection.
export const LEGACY_USER = { userId: 1136575387, timezone: "Asia/Kolkata" };

export async function getUserProfile(userId) {
    const db = await getDB();
    return db.collection(USERS_COLLECTION).findOne({ userId });
}

export async function createUserProfile(userId, profileData) {
    const db = await getDB();
    const newUser = {
        userId,
        ...profileData,
        createdAt: new Date(),
        updatedAt: new Date()
    };
    await db.collection(USERS_COLLECTION).insertOne(newUser);
    return newUser;
}

export async function updateUserProfile(userId, updates) {
    const db = await getDB();
    await db.collection(USERS_COLLECTION).updateOne(
        { userId },
        { $set: { ...updates, updatedAt: new Date() } }
    );
}

export async function updateUserApiKeys(userId, provider, apiKey) {
    const db = await getDB();
    const updateObj = {};
    updateObj[`apiKeys.${provider}`] = apiKey;
    updateObj["updatedAt"] = new Date();

    await db.collection(USERS_COLLECTION).updateOne(
        { userId },
        { $set: updateObj }
    );
}

export async function getAllUsersWithTriggers() {
    const db = await getDB();
    // Return all users who have opted into triggers
    return db.collection(USERS_COLLECTION).find({ "preferences.triggersOptIn": true }).toArray();
}

/** Who a routine should fire for: an explicit user, else everyone opted in. */
export async function resolveRoutineTargets(user) {
    if (user?.userId) return [user];
    const users = await getAllUsersWithTriggers();
    return users.length ? users : [LEGACY_USER];
}

/* ─────────────────────────── identity resolution ───────────────────────────
 *
 * userId is an IDENTITY — the number every collection stores.
 * address is an ADDRESS — where a channel delivers a message.
 *
 * They were the same number while the bot had one Telegram user, and five call
 * sites came to rely on that: both routine jobs, connectorButton, notifyUser,
 * and the reminder payloads. Any code that sends must go through resolveAddress;
 * passing userId to sendMessage now delivers to a chat that does not exist.
 */

/**
 * Hand out the next internal user id.
 *
 * findOneAndUpdate with $inc is atomic per document, so two signups in the same
 * tick cannot collide — which is the entire reason this is not `count() + 1`.
 */
export async function allocateUserId() {
    const db = await getDB();
    const counter = await db.collection(COUNTERS).findOneAndUpdate(
        { _id: USER_ID_SEQUENCE },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" }
    );
    return counter.seq;
}

/**
 * Map an inbound message's channel id onto our internal user, creating both the
 * user and the identity on first contact.
 *
 * `externalId` must be the id of the PERSON (Telegram's message.from.id), never
 * the chat. In a private chat they are equal; in a group, chat.id is the group,
 * so keying on it would merge every member into one user sharing one set of
 * expenses, tasks, and diet logs.
 *
 * Returns { userId, address, isNew }. isNew is what the caller uses to decide
 * whether to open the onboarding flow.
 */
export async function resolveUserByChannel(channel, externalId, { address = null, displayName = null } = {}) {
    if (!channel || externalId === undefined || externalId === null) {
        throw new Error(`[resolveUserByChannel] channel and externalId are required, got ${channel}/${externalId}`);
    }

    const db = await getDB();
    const identities = db.collection(USER_IDENTITY);

    // Stored as strings — see the externalId note in userIdentitySchema.js.
    const key = { channel, externalId: String(externalId) };
    const addressStr = address === null || address === undefined ? null : String(address);

    const existing = await identities.findOne(key);
    if (existing) {
        // A user can write from a chat we have not seen. Keep the outbound
        // address current, or replies to a moved conversation go nowhere.
        if (addressStr && addressStr !== existing.address) {
            await identities.updateOne(key, { $set: { address: addressStr, updatedAt: new Date() } });
        }
        return { userId: existing.userId, address: addressStr ?? existing.address, isNew: false };
    }

    const userId = await allocateUserId();
    const now = new Date();

    try {
        // Raw driver, like every other users write — the collection is
        // deliberately outside the createRecord registry (CLAUDE.md §5).
        await db.collection(USERS_COLLECTION).insertOne({
            userId,
            name: displayName || `user${userId}`,
            timezone: DEFAULT_TIMEZONE,
            status: "active",
            // Off until onboarding asks. A routine is a message the user did not
            // request, so it is opt-in rather than opt-out.
            preferences: { triggersOptIn: false },
            onboardedAt: null,
            createdAt: now,
            updatedAt: now,
        });

        await identities.insertOne({
            userId,
            ...key,
            address: addressStr,
            displayName,
            isPrimary: true,
            linkedAt: now,
            createdAt: now,
            updatedAt: now,
        });
    } catch (err) {
        // 11000 = duplicate key on (channel, externalId): a concurrent first
        // message from the same person won the race. Re-read rather than mint a
        // second userId for one person. The users row this call already
        // inserted is orphaned, which costs one skipped id and nothing else.
        if (err?.code !== 11000) throw err;

        const winner = await identities.findOne(key);
        if (!winner) throw err;
        return { userId: winner.userId, address: addressStr ?? winner.address, isNew: false };
    }

    return { userId, address: addressStr, isNew: true };
}

/**
 * Where to send this user a message on a channel. Returns null when we have no
 * identity for them there — callers must treat that as "cannot deliver" rather
 * than falling back to userId, which is what this whole layer exists to stop.
 */
export async function resolveAddress(userId, channel = "telegram") {
    const db = await getDB();
    const identity = await db.collection(USER_IDENTITY).findOne(
        { userId, channel },
        // isPrimary first so a user reachable in several chats gets the one they
        // actually signed up in, not whichever group the bot happened to join.
        { sort: { isPrimary: -1, linkedAt: 1 } }
    );
    return identity?.address ?? null;
}
