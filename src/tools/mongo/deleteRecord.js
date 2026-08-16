import { ObjectId } from "mongodb";
import { getDB } from "./mongoClient.js";
import { DIET_REGISTER } from "./schema/dietRegisterSchema.js";
import { EXPENSE_REGISTER } from "./schema/expenseRegisterSchema.js";
import { TASK_REGISTER } from "./schema/taskRegisterSchema.js";

/**
 * Deliberately narrower than the fetch whitelist. Only the three day logs —
 * the things the user dictates casually and therefore gets wrong casually.
 *
 * Not deletable, and why:
 *   taskCalendar   a task is cancelled by setting status, not by removal, and
 *                  taskRegister rows reference task ids
 *   userSchedule   re-locking a day should replace the schedule, not erase it
 *   triggerJob     removing a job is a scheduling decision, not a data fix
 *   chatHistory    the audit trail; nothing should be able to rewrite it
 */
const DELETABLE_COLLECTIONS = {
    dietRegister: DIET_REGISTER,
    taskRegister: TASK_REGISTER,
    expenseRegister: EXPENSE_REGISTER,
};

/**
 * Delete one record by _id.
 *
 * Exists because the agent had no way to undo a mistake. On 2026-08-13 it
 * created two duplicate documents, recognised the problem, and "resolved" it
 * by rewriting their date to 2019-12-31 with the note "Duplicate entry moved
 * to past" — the junk is still in the database.
 *
 * userId is required and is part of the delete filter, not just a check: a
 * wrong _id then deletes nothing rather than another user's row.
 *
 * @param {string} collectionName
 * @param {string} id      24-char hex _id from a fetchRecord result
 * @param {number} userId
 * @param {string} reason  why — recorded in the log line, not the database
 */
export async function deleteRecord(collectionName, id, userId, reason) {
    const resolved = DELETABLE_COLLECTIONS[collectionName];
    if (!resolved) {
        throw new Error(
            `Cannot delete from "${collectionName}". Deletable collections: ` +
            `${Object.keys(DELETABLE_COLLECTIONS).join(", ")}. ` +
            `To cancel a task set its status via updateRecords instead.`
        );
    }

    if (!userId) throw new Error("userId is required to delete a record.");

    let objectId;
    try {
        objectId = ObjectId.createFromHexString(String(id));
    } catch {
        throw new Error(
            `Invalid id: "${id}" is not a 24-character hex _id. ` +
            `Call fetchRecord first and use the exact _id it returned.`
        );
    }

    const db = await getDB();
    const collection = db.collection(resolved);

    // Read first so the log line says what was removed. Without it a wrong
    // delete leaves nothing to reconstruct from.
    const existing = await collection.findOne({ _id: objectId, userId });
    if (!existing) {
        throw new Error(
            `No record ${id} found in ${collectionName} for this user. ` +
            `It may already be deleted, or the _id may be from a different collection.`
        );
    }

    const result = await collection.deleteOne({ _id: objectId, userId });

    console.log(
        `[deleteRecord] ${collectionName} ${id} removed (reason: ${reason || "unspecified"})\n` +
        `               was: ${JSON.stringify(existing)}`
    );

    return {
        success: result.deletedCount === 1,
        deletedCount: result.deletedCount,
        deleted: existing,
    };
}

export { DELETABLE_COLLECTIONS };
