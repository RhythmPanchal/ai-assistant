import { getDB } from "../tools/mongo/mongoClient.js";

const USERS_COLLECTION = "users";

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
