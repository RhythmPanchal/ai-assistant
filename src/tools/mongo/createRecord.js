import { getDB } from "./mongoClient.js";
import fetchCollectionNameAndSchema from "./fetchCollectionSchema.js";
import ValidateSchema from "./validateSchema.js";
import { normalizeDates } from "./validateSchema.js";


export async function createRecord(collectionName, data) {
  if (!collectionName || !data) {
    throw new Error("Invalid parameter: collectionName and data are required.");
  }

  // Parse JSON first — only this step should raise an "Invalid JSON" error.
  let parsed;
  try {
    parsed = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) {
    throw new Error(`Invalid JSON string provided for data: ${e.message}`);
  }

  // Normalize and validate separately so schema-validation errors
  // surface their real message to the caller (and to the LLM).
  const refinedData = normalizeDates(parsed);
  ValidateSchema(collectionName, refinedData);

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



