import { BaseTool, ToolResult } from "../BaseTool.js";
import { updateRecords } from "../../../tools/mongo/updateRecord.js";

export class UpdateRecordsTool extends BaseTool {
    static name = "updateRecords";
    static description = "Update one or more records by _id. You MUST call fetchRecord first to get real _ids — NEVER fabricate an _id. Send a single-element array for one record, or multiple elements for batch updates.";
    static parameters = {
        type: "object",
        properties: {
            records: {
                type: "array",
                description: "Array of update operations. Do NOT include _id, createdAt, or updatedAt inside data.",
                items: {
                    type: "object",
                    properties: {
                        collectionName: {
                            type: "string",
                            description: "Collection name from fetchCollectionNameAndSchema.",
                        },
                        id: {
                            type: "string",
                            description: "The exact _id (24-char hex) from a fetchRecord response. NEVER fabricate.",
                        },
                        data: {
                            type: "object",
                            description: "Fields to update. Only include changed fields.",
                        },
                    },
                    required: ["collectionName", "id", "data"],
                },
            },
        },
        required: ["records"],
    };

    async execute({ records }) {
        const result = await updateRecords(records);
        return new ToolResult(true, `Successfully updated records.`, result);
    }
}

