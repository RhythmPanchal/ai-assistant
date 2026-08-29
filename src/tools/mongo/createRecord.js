import { getDB } from "./mongoClient.js";
import fetchCollectionNameAndSchema from "./fetchCollectionSchema.js";
import ValidateSchema from "./validateSchema.js";
import { normalizeDates } from "./validateSchema.js";
import { getUserContext } from "../../identity/userContext.js";


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

  // Stamp the owner from the context, overwriting anything supplied. `data` is
  // built by the model on most paths, so a userId in it is a claim rather than
  // a fact — this is what stops a row being filed under someone else.
  //
  // Only for collections that actually have an owner. factKey is shared
  // vocabulary and oauthConnector is app config; forcing a userId onto either
  // would fail schema validation for no gain.
  const context = getUserContext();
  const schema = fetchCollectionNameAndSchema()[collectionName]?.schema;
  const owned = Boolean(schema?.properties?.userId);
  const scoped = owned && !context.isSystem
    ? { ...parsed, userId: context.userId }
    : parsed;

  // Normalize and validate separately so schema-validation errors
  // surface their real message to the caller (and to the LLM).
  const refinedData = normalizeDates(scoped);
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



