import { BaseTool, ToolResult } from "../BaseTool.js";
import { createCollection } from "../../../tools/mongo/createCollection.js";

export class CreateCollectionTool extends BaseTool {
    static name = "createCollection";
    static description = "Create a MongoDB collection if it does not exist.";
    static parameters = {
        type: "object",
        properties: {
            collectionName: { type: "string" },
        },
        required: ["collectionName"],
    };

    async execute({ collectionName }) {
        const result = await createCollection(collectionName);
        return new ToolResult(true, `Created collection ${collectionName}`, result);
    }
}

