import { BaseTool, ToolResult } from "../BaseTool.js";
import { deleteRecord } from "../../../tools/mongo/deleteRecord.js";

export class DeleteRecordTool extends BaseTool {
    static name = "deleteRecord";
    static description =
        "Delete ONE record you created by mistake — a duplicate, or something logged against the wrong day that cannot be corrected with updateRecords. " +
        "Only dietRegister, taskRegister and expenseRegister can be deleted. " +
        "You MUST call fetchRecord first and pass the exact _id it returned; never guess an _id. " +
        "Prefer updateRecords whenever the record can be fixed rather than removed, and to cancel a task set its status instead of deleting it. " +
        "If the user asks to remove something and you are not certain which record they mean, ask before calling this.";

    static parameters = {
        type: "object",
        properties: {
            collectionName: {
                type: "string",
                enum: ["dietRegister", "taskRegister", "expenseRegister"],
                description: "Collection holding the record.",
            },
            id: {
                type: "string",
                description: "The exact 24-character hex _id from a fetchRecord response. NEVER fabricate.",
            },
            userId: {
                type: "integer",
                description: "Owner of the record. Part of the delete filter, so a wrong _id deletes nothing.",
            },
            reason: {
                type: "string",
                description: "Short reason, e.g. 'duplicate of 6a7b8b17' or 'user says this was not today'. Logged for the audit trail.",
            },
        },
        required: ["collectionName", "id", "userId", "reason"],
    };

    async execute({ collectionName, id, userId, reason }) {
        const result = await deleteRecord(collectionName, id, userId, reason);
        return new ToolResult(
            true,
            `Deleted 1 record from ${collectionName}.`,
            result
        );
    }
}
