import { BaseTool, ToolResult } from "../BaseTool.js";
import { getDB } from "../../../tools/mongo/mongoClient.js";
import { ACTIVE_FLOWS } from "../../../tools/mongo/schema/activeFlowsSchema.js";

export class UpdateFlowScratchpadTool extends BaseTool {
    static name = "updateFlowScratchpad";
    static description =
        "Save state you need in later turns of the currently active flow. " +
        "What you send is MERGED into what is already saved: send only the keys you are changing, " +
        "and every other key is kept as it was.";
    static parameters = {
        type: "object",
        properties: {
            flowType: { type: "string", description: "The type of flow (e.g. 'goodMorning', 'goodNight')" },
            scratchpad: {
                type: "object",
                description:
                    "Only the keys to set, e.g. { unrelatedReplies: 1 }. A key you leave out keeps its saved value.",
            },
        },
        required: ["flowType", "scratchpad"],
    };

    async execute(args) {
        const { userId, flowType, scratchpad } = args;

        if (!scratchpad || typeof scratchpad !== "object" || Array.isArray(scratchpad)) {
            return new ToolResult(false, "scratchpad must be an object of the keys to set, e.g. { unrelatedReplies: 1 }.");
        }

        const db = await getDB();

        // A pipeline update, merging, rather than $set of the whole object.
        //
        // $set replaced the scratchpad wholesale, so a write of one key erased
        // every other — invisible while unrelatedReplies was the only key
        // anything used, and silent data loss the moment a flow keeps two.
        //
        // Not a dotted $set either: openFlow writes scratchpad: null, and Mongo
        // refuses to create a field inside null. $ifNull starts the merge from
        // an empty object instead. $literal keeps the model's values as data —
        // inside a pipeline, a string that happens to start with "$" is
        // otherwise read as a field path.
        const result = await db.collection(ACTIVE_FLOWS).findOneAndUpdate(
            { userId, flowType, state: "open" },
            [{
                $set: {
                    scratchpad: { $mergeObjects: [{ $ifNull: ["$scratchpad", {}] }, { $literal: scratchpad }] },
                    updatedAt: new Date(),
                },
            }],
            { returnDocument: "after" }
        );

        // ToolResult has no static helpers — only a constructor.
        if (!result) {
            return new ToolResult(false, `No open flow of type "${flowType}" found for user ${userId}.`);
        }

        // The whole merged state back, not just the keys sent, so the model sees
        // what is now saved rather than assuming.
        return new ToolResult(true, `Scratchpad updated for flow "${flowType}".`, { scratchpad: result.scratchpad });
    }
}
