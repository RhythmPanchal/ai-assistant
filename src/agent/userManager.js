import { getDB } from "../tools/mongo/mongoClient.js";
import { USERS } from "../tools/mongo/schema/usersSchema.js";

const USERS_COLLECTION = USERS;

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
