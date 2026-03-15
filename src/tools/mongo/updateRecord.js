import { getDB } from "./mongoClient.js";

export async function updateRecord(collectionName, data) {
    
    try {
        data = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
        throw new Error("Invalid JSON string provided for data");
    }

    if (!collectionName || !data) {
        throw new Error("Invalid parameter: collectionName and data are required.");
    }
    const db = await getDB();
    const collection = db.collection(collectionName);
    const result = await collection.insertOne({
        ...data,
        createdAt: new Date(),
    });

    return {
        success: true,
        insertedId: result.insertedId,
    };
}



