import { BaseTool, ToolResult } from "../BaseTool.js";
import { completeFlow } from "../../../scheduler/flows/completeFlow.js";

export class CompleteFlowTool extends BaseTool {
    static name = "completeFlow";
    static description = "Close the user's currently-open scheduled-routine flow (e.g. 'goodNight', 'goodMorning'). Call this ONLY when the active flow's overlay instructions say its completion criteria are met. Do NOT call for normal ad-hoc chat — only when a routine flow is active and finishing.";
    static parameters = {
        type: "object",
        properties: {
            userId: {
                type: "integer",
                description: "Identifier of the user whose flow should be closed.",
            },
            flowType: {
                type: "string",
                enum: ["goodNight", "goodMorning"],
                description: "Which flow to close.",
            },
            reason: {
                type: "string",
                enum: ["done", "skipped"],
                description: "Why the flow is closing. 'done' = completion criteria met. 'skipped' = user explicitly opted out for tonight/today.",
            },
        },
        required: ["userId", "flowType", "reason"],
    };

    async execute({ userId, flowType, reason }) {
        const result = await completeFlow(userId, flowType, reason);
        return new ToolResult(true, `Completed flow ${flowType} for user ${userId} with reason ${reason}.`, result);
    }
}

