import { BaseTool, ToolResult } from "../BaseTool.js";
import { completeFlow } from "../../../scheduler/flows/completeFlow.js";
import { routinesLine } from "../../../knowledge/userProfileKnowledge.js";

export class CompleteFlowTool extends BaseTool {
    static name = "completeFlow";
    static description = "Close the user's currently-open flow — a routine ('goodNight', 'goodMorning') or 'onboarding'. Call this ONLY when the active flow's overlay instructions say its completion criteria are met. Do NOT call for normal ad-hoc chat — only when a flow is active and finishing.";
    static parameters = {
        type: "object",
        properties: {
            flowType: {
                type: "string",
                enum: ["goodNight", "goodMorning", "onboarding"],
                description: "Which flow to close.",
            },
            reason: {
                type: "string",
                enum: ["done", "skipped"],
                description: "Why the flow is closing. 'done' = completion criteria met. 'skipped' = the user opted out or stopped answering.",
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
        if (result?.notFinished) {
            return new ToolResult(false, `Not closed: ${result.message}`, result);
        }
        if (!result?.success) {
            return new ToolResult(false, `No open ${flowType} flow to complete — ${result?.message ?? "nothing was closed"}.`, result);
        }

        // Onboarding's completion switches routines on unless they chose
        // otherwise, and the closing reply has to say which — so say it here.
        if (result.onboarding) {
            const routines = routinesLine(result.onboarding);
            // A review finishing changes nothing about routines — the eval had
            // one tell an existing user their routines "start from now".
            if (!result.onboarding.firstCompletion) {
                return new ToolResult(true, "Completed the review. Their routines are unchanged — do not mention them.", result);
            }
            return new ToolResult(true,
                result.onboarding.preferences?.triggersOptIn
                    ? `Completed onboarding. Their ${routines}: tell them these start from now, with the times.`
                    : "Completed onboarding. Their routines stay off, as they chose — do not offer them again.",
                result);
        }

        // userId is deliberately not echoed back: the model no longer supplies it
        // and no longer sees it anywhere else, so repeating it here is noise.
        return new ToolResult(true, `Completed flow ${flowType} with reason ${reason}.`, result);
    }
}

