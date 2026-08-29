import { BaseTool, ToolResult } from "../BaseTool.js";
import { completeFlow } from "../../../scheduler/flows/completeFlow.js";

export class CompleteFlowTool extends BaseTool {
    static name = "completeFlow";
    static description = "Close the user's currently-open scheduled-routine flow (e.g. 'goodNight', 'goodMorning'). Call this ONLY when the active flow's overlay instructions say its completion criteria are met. Do NOT call for normal ad-hoc chat — only when a routine flow is active and finishing.";
    static parameters = {
        type: "object",
        properties: {
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
        required: ["flowType", "reason"],
    };

    async execute({ userId, flowType, reason }) {
        const result = await completeFlow(userId, flowType, reason);

        // closeFlowByAgent returns null when no flow of this type was open, which
        // completeFlow turns into { success: false } rather than a throw. Saying
        // "Completed" there let the model believe it had closed a routine that
        // had never opened, and stop performing it.
        if (!result?.success) {
            return new ToolResult(false, `No open ${flowType} flow to complete — ${result?.message ?? "nothing was closed"}.`, result);
        }

        // userId is deliberately not echoed back: the model no longer supplies it
        // and no longer sees it anywhere else, so repeating it here is noise.
        return new ToolResult(true, `Completed flow ${flowType} with reason ${reason}.`, result);
    }
}

