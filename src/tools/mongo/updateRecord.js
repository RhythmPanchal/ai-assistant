import { getDB } from "./mongoClient.js";

export async function updateRecord(args) {
    const collectionName = args.collectionName; 
    
    
    let data;
    try {
        data = typeof args.data === 'string' ? JSON.parse(args.data) : args.data;
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



