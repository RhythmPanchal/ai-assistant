import { ObjectId } from "mongodb";
import { getDB } from "./mongoClient.js";
import fetchCollectionNameAndSchema from "./fetchCollectionSchema.js";
import ValidateSchema from "./validateSchema.js";
import { normalizeDates } from "./validateSchema.js";
import { getUserContext } from "../../identity/userContext.js";

async function processUpdate(collectionName, id, data) {
    // Identity first, before parsing or connecting. An unbound caller must fail
    // having done nothing at all.
    const context = getUserContext();

    // 1. Parse data if it's a JSON string
    try {
        data = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
        throw new Error("Invalid JSON string provided for data");
    }

    if (!collectionName || !id || !data) {
        throw new Error("Invalid parameter: collectionName, id, and data are required.");
    }

    // 2. Resolve the actual collection name from the schema registry
    const schemas = fetchCollectionNameAndSchema();
    const collectionConfig = schemas[collectionName];
    if (!collectionConfig) {
        throw new Error(`Unknown collection: "${collectionName}". Call fetchCollectionNameAndSchema to get valid collection names.`);
    }
    const resolvedCollectionName = collectionConfig.collectionName;

    // 3. Normalize date strings to Date objects
    const refinedData = normalizeDates(data);

    // 4. Validate the updated fields against the collection schema
    //    skipRequired=true because updates are partial — only supplied fields need validation
    await ValidateSchema(collectionName, refinedData, { skipRequired: true });

    // 5. Connect and find the existing record by _id
    const db = await getDB();
    const collection = db.collection(resolvedCollectionName);

    let objectId;
    try {
        objectId = ObjectId.createFromHexString(id);
    } catch (e) {
        throw new Error(`Invalid id: "${id}" is not a valid ObjectId.`);
    }

    // The owner is part of the FILTER, not a check afterwards — the same shape
    // deleteRecord already uses. Matching on _id alone meant any valid id
    // rewrote any user's row, and _id values travel through the model. Scoped
    // like this, a foreign id simply matches nothing.
    const scope = context.isSystem ? { _id: objectId } : { _id: objectId, userId: context.userId };

    const existingRecord = await collection.findOne(scope);
    if (!existingRecord) {
        // Deliberately does not distinguish "no such record" from "not yours".
        // Telling the model which one it hit turns this into a probe for whether
        // an id exists on another account.
        throw new Error(`Record with id "${id}" not found in collection "${collectionName}".`);
    }

    // 6. Perform the update with $set and stamp updatedAt
    const result = await collection.updateOne(
        scope,
        {
            $set: {
                ...refinedData,
                // userId is never patchable. Without this a model could hand a
                // record to another account by "updating" its owner.
                ...(context.isSystem ? {} : { userId: context.userId }),
                updatedAt: new Date(),
            },
        }
    );

    return {
        success: true,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
    };
}

export async function updateRecords(records) {

    // Parse if it's a JSON string
    try {
        records = typeof records === 'string' ? JSON.parse(records) : records;
    } catch (e) {
        throw new Error("Invalid JSON string provided for records");
    }

    if (!Array.isArray(records) || records.length === 0) {
        throw new Error("records must be a non-empty array of { collectionName, id, data } objects.");
    }

    const results = [];

    for (const [index, record] of records.entries()) {
        const { collectionName, id, data } = record;

        if (!collectionName || !id || !data) {
            results.push({
                index,
                success: false,
                error: `Missing required field(s) at index ${index}. Each record needs collectionName, id, and data.`,
            });
            continue;
        }

        try {
            const result = await processUpdate(collectionName, id, data);
            results.push({ index, ...result });
        } catch (e) {
            results.push({
                index,
                success: false,
                error: e.message,
            });
        }
    }

    return {
        totalRequested: records.length,
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length,
        results,
    };
}
