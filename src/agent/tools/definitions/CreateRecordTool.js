import { BaseTool, ToolResult } from "../BaseTool.js";
import { createRecord } from "../../../tools/mongo/createRecord.js";

export class CreateRecordTool extends BaseTool {
    static name = "createRecord";
    static description = "Insert a record into a MongoDB collection. You MUST call fetchCollectionNameAndSchema first to know the correct collection name and schema before using this tool.";
    static parameters = {
        type: "object",
        properties: {
            collectionName: { type: "string" },
            data: {
                type: "object",
                description: "The object to insert. Field names and types must match the collection's schema as returned by fetchCollectionNameAndSchema."
            },
        },
        required: ["collectionName", "data"],
    };

    async execute({ collectionName, data }) {
        const result = await createRecord(collectionName, data);
        return new ToolResult(true, `Successfully inserted record into ${collectionName}`, result);
    }
}

