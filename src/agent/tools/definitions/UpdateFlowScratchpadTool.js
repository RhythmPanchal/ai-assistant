import { BaseTool, ToolResult } from "../BaseTool.js";
import { getDB } from "../../../tools/mongo/mongoClient.js";
import { ACTIVE_FLOWS } from "../../../tools/mongo/schema/activeFlowsSchema.js";

export class UpdateFlowScratchpadTool extends BaseTool {
    static name = "updateFlowScratchpad";
    static description = "Updates the scratchpad for the currently active flow. Use this to save your thought process or state so you don't forget it in subsequent turns.";
    static parameters = {
        type: "object",
        properties: {
            userId: { type: "integer", description: "The user's Telegram ID" },
            flowType: { type: "string", description: "The type of flow (e.g. 'goodMorning', 'goodNight')" },
            scratchpad: { type: "object", description: "State to carry into later turns of this flow, e.g. { unrelatedReplies: 1 }" }
        },
        required: ["userId", "flowType", "scratchpad"]
    };

    async execute(args) {
        const { userId, flowType, scratchpad } = args;
        const db = await getDB();
        
        const result = await db.collection(ACTIVE_FLOWS).findOneAndUpdate(
            { userId, flowType, state: "open" },
            { $set: { scratchpad, updatedAt: new Date() } },
            { returnDocument: "after" }
        );

        // ToolResult has no static helpers — only a constructor.
        if (!result) {
            return new ToolResult(false, `No open flow of type "${flowType}" found for user ${userId}.`);
        }

        return new ToolResult(true, `Scratchpad updated for flow "${flowType}".`, { scratchpad });
    }
}
