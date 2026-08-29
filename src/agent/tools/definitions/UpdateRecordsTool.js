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

        // updateRecords never throws for a failed row: it catches per record and
        // returns the outcomes. A blanket true therefore reported "Successfully
        // updated records" even for a batch in which every single one failed.
        if (result.failureCount > 0) {
            const detail = result.results
                .filter(r => !r.success)
                .map(r => `[${r.index}] ${r.error}`)
                .join("; ");

            // Partial success stays success for the rows that did land — the
            // model needs both halves to know what is left to retry.
            return new ToolResult(
                result.successCount > 0,
                `Updated ${result.successCount} of ${result.totalRequested}. Failed: ${detail}`,
                result
            );
        }

        return new ToolResult(true, `Successfully updated records.`, result);
    }
}

