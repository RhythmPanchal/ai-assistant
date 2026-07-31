import { BaseTool, ToolResult } from "../BaseTool.js";
import fetchCollectionNameAndSchema from "../../../tools/mongo/fetchCollectionSchema.js";

export class FetchCollectionNameAndSchemaTool extends BaseTool {
    static name = "fetchCollectionNameAndSchema";
    static description = "Fetches all available collection names, their schemas, and descriptions from MongoDB. You MUST call this before any read or write operation to know the correct collection name and its schema.";
    static parameters = {
        type: "object",
        properties: {}
    };

    async execute() {
        const result = await fetchCollectionNameAndSchema();
        return new ToolResult(true, "Fetched collection schemas.", result);
    }
}

