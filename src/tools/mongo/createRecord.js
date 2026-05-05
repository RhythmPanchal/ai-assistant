import { getDB } from "./mongoClient.js";
import fetchCollectionNameAndSchema from "./fetchCollectionSchema.js";
import ValidateSchema from "./validateSchema.js";
import { normalizeDates } from "./validateSchema.js";


export async function createRecord(collectionName, data) {
  let refinedData = {};
  try {
    data = typeof data === 'string' ? JSON.parse(data) : data;
    refinedData = normalizeDates(data);
    const validatedData = ValidateSchema(collectionName, refinedData);
  } catch (e) {
    throw new Error("Invalid JSON string provided for data");
  }

  if (!collectionName || !data) {
    throw new Error("Invalid parameter: collectionName and data are required.");
  }

  const db = await getDB();
  const collection = db.collection(collectionName);
  const result = await collection.insertOne({
    ...refinedData,
    createdAt: new Date(),
  });

  return {
    success: true,
    insertedId: result.insertedId,
  };
}



