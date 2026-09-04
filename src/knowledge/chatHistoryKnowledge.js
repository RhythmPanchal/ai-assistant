import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";


const MAX_HISTORY_TURNS = 50;

// Fallback when the current day has nothing yet. Kept small on purpose: this is
// yesterday's context bleeding into today, useful for continuity ("the thing we
// discussed last night") but wrong to lean on heavily.
const FALLBACK_TURNS = 5;
const FALLBACK_MAX_MESSAGES = 15;

/**
 * Turns produced by a system pass rather than a conversation.
 *
 * The summarize pass runs through runAgent and so persists a chatHistory
 * document like any other turn — one whose "user" message is a job instruction
 * and whose reply is a note to a log. Replayed as history it reads as the user
 * having asked for a summary, and the agent picks the thread back up.
 *
 * $ne matches documents where the field is ABSENT, which is every row written
 * before `source` existed — so this excludes the summarize turns and nothing
 * else. A range operator would not: Mongo type-brackets those, and $gt/$lt
 * against a string drops every row missing the field.
 */
const EXCLUDE_SYSTEM_TURNS = { source: { $ne: "summarizeJob" } };

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
            ...EXCLUDE_SYSTEM_TURNS,
        })
        .sort({ createdAt: -1 })
        .limit(MAX_HISTORY_TURNS)
        .toArray();

    return recent.reverse();
}

/**
 * The most recent turns regardless of day. Used only when today is still empty.
 */
async function fetchRecentChatRecords(userId, limit) {
    const db = await getDB();
    const recent = await db
        .collection(CHAT_HISTORY)
        .find({ userId, ...EXCLUDE_SYSTEM_TURNS })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

    return recent.reverse();
}

/**
 * Returns provider-neutral chat history for ProviderManager.
 *
 * History is day-scoped so context resets each morning. But the first message
 * of a day arrives into a completely empty history — on 2026-08-16 the user's
 * 13:34 message had nothing behind it but the 09:00 job — so the agent opens
 * cold and cannot refer to anything discussed the night before. When today has
 * nothing yet, fall back to the last few turns whenever they happened.
 */
export default async function chatHistoryKnowledge(userId) {
    let conversations = await fetchTodayChatRecords(userId);
    let history = formatChatHistoryForGeneric(conversations);

    if (history.length === 0) {
        conversations = await fetchRecentChatRecords(userId, FALLBACK_TURNS);
        history = formatChatHistoryForGeneric(conversations);
        // Trim from the FRONT so the newest turns survive.
        if (history.length > FALLBACK_MAX_MESSAGES) {
            history = history.slice(-FALLBACK_MAX_MESSAGES);
        }
        // A history that opens on an assistant turn is a dangling reply with no
        // prompt; some providers reject it outright.
        while (history.length && history[0].role !== "user") history.shift();

        if (history.length) {
            console.log(`[chatHistoryKnowledge] today empty — carried ${history.length} messages from previous days`);
        }
    }

    return history;
}
