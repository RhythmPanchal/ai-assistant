import { BaseTool, ToolResult } from "../BaseTool.js";
import { rememberFacts } from "../../../tools/mongo/operation/userFacts.js";

export class RememberFactTool extends BaseTool {
    static name = "rememberFact";
    static description =
        "Save durable facts about who the user IS, so you know them in future conversations. " +
        "Call this when the user tells you something about themselves that will still be true next week — where they live, what they do, what they are working towards, how they want you to talk to them, a constraint you should respect. " +
        "Do NOT call it for things that happened: an expense, a meal, a completed task and a reminder all belong in their own collections. 'I spent 200 on lunch' is an expense; 'I am vegetarian' is a fact. " +
        "Prefer a key that already appears in the user's profile block — reusing 'work.status' updates what you know, while inventing 'employment.status' leaves two contradictory entries. Invent a new dot-separated key only when nothing existing fits.";
    static parameters = {
        type: "object",
        properties: {
            userId: {
                type: "integer",
                description: "Identifier of the user these facts describe.",
            },
            facts: {
                type: "array",
                description: "One entry per distinct fact. Save several at once rather than calling repeatedly.",
                items: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "Lowercase dot-separated slug, e.g. 'work.status', 'location.current'. Reuse the key already shown in the profile block when one fits.",
                        },
                        fact: {
                            type: "string",
                            description:
                                "One self-contained sentence, readable on its own mid-prompt. 'In Pune since June 2026 for work.' — not 'Pune'.",
                        },
                        category: {
                            type: "string",
                            enum: ["identity", "location", "work", "money", "health", "routine", "social", "style", "other"],
                            description: "Which group this renders under. Defaults to the key's namespace.",
                        },
                        stability: {
                            type: "string",
                            enum: ["stable", "temporary"],
                            description:
                                "'temporary' for things expected to change — a current city, a job hunt, an exam being studied for. 'stable' for a home town or a profession.",
                        },
                        confidence: {
                            type: "string",
                            enum: ["stated", "inferred"],
                            description:
                                "'stated' only when the user actually said it. Use 'inferred' when you worked it out from behaviour — it will be shown to you as unconfirmed later.",
                        },
                        expiresAt: {
                            type: "string",
                            description:
                                "Optional ISO date after which this should stop being assumed. Worth setting on anything temporary.",
                        },
                    },
                    required: ["key", "fact"],
                },
            },
        },
        required: ["userId", "facts"],
    };

    async execute({ userId, facts }) {
        const { saved, rejected } = await rememberFacts(userId, facts);

        const summary = saved.length
            ? saved.map(s => `${s.key} (${s.action})`).join(", ")
            : "nothing saved";

        // Rejections go back to the model rather than being swallowed, so it can
        // fix a malformed key itself instead of believing the write landed.
        if (rejected.length) {
            return new ToolResult(
                saved.length > 0,
                `Saved: ${summary}. Rejected: ${rejected.map(r => `${r.key} — ${r.reason}`).join("; ")}`,
                { saved, rejected }
            );
        }

        return new ToolResult(true, `Remembered ${saved.length} fact(s): ${summary}`, { saved });
    }
}
