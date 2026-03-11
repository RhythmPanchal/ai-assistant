import { getDB } from "./mongoClient.js";
import fetchCollectionNameAndSchema from "./fetchCollectionSchema.js";
import ValidateSchema from "./validateSchema.js";

//LLM can not generate data with date-time format.
//it gives strings, so we need to convert it.
//otherwise schema validation will break. 
function normalizeDates(obj) {
  for (const key in obj) {
    if (
      typeof obj[key] === "string" &&
      !isNaN(Date.parse(obj[key]))
    ) {
      obj[key] = new Date(obj[key]);
    }
  }
  return obj;
}



export async function createRecord(args) {
    const collectionName = args.collectionName; 
    let refinedData = {}; 
    // CHANGED: Parse the string back to an object
    let data;
    try {
      data = typeof args.data === 'string' ? JSON.parse(args.data) : args.data;
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



