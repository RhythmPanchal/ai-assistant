import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";

// Cap the number of past turns we replay to Gemini. Each turn is one
// runAgent call (one chatHistory doc). 15 turns is enough recall for
// same-day context without ballooning the prompt — compaction of the
// older window will land in a follow-up PR.
const MAX_HISTORY_TURNS = 15;

/**
 * Converts conversation documents into the provider-neutral shape every
 * LLM provider translates: [{ role: "user" | "assistant", content }].
 *
 * Was Gemini-specific ([{ role, parts }]). Now that runAgent can fall back to
 * Groq/OpenRouter, the history must not be pre-shaped for one vendor —
 * GeminiProvider and OpenAICompatibleProvider each convert it themselves.
 */
function formatChatHistoryForGeneric(conversations) {
    const history = [];

    for (const conv of conversations) {
        for (const msg of conv.messages) {
            if (msg.role === "user") {
                history.push({ role: "user", content: msg.content });
            } else if (msg.role === "assistant") {
                // Text replies only. A tool-call turn is only valid when
                // immediately followed by its tool results, and we drop those
                // to save context — so the matching call must go too, or
                // strict providers reject the whole request.
                if (msg.content) history.push({ role: "assistant", content: msg.content });
            }
            // msg.role === "tool" — skipped, see above.
        }
    }

    return history;
}

async function fetchTodayChatRecords(userId) {
    if (!userId) {
        console.trace();
        throw new Error("userId is required to fetch chat history");
    }

    const db = await getDB();
    const collection = db.collection(CHAT_HISTORY);

    // Get today's date range (local day)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Pull the N most recent turns (newest first), then reverse for
    // chronological replay. This avoids loading the entire day's history
    // once the conversation gets long.
    const recent = await collection
        .find({
            userId: userId,
            createdAt: {
                $gte: startOfDay,
                $lte: endOfDay,
            },
        })
        .sort({ createdAt: -1 })
        .limit(MAX_HISTORY_TURNS)
        .toArray();

    return recent.reverse();
}

/** Returns provider-neutral chat history for ProviderManager. */
export default async function chatHistoryKnowledge(userId) {
    const conversations = await fetchTodayChatRecords(userId);
    return formatChatHistoryForGeneric(conversations);
}
