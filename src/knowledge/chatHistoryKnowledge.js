import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";

/**
 * Converts DB records into Gemini-compatible chat history format.
 * Maps "assistant" → "model" as required by the Gemini API.
 * Returns: [{ role: "user"|"model", parts: [{ text: "..." }] }, ...]
 */
function formatChatHistoryForGemini(records) {
    return records.map(r => ({
        role: r.role === "assistant" ? "model" : r.role,
        parts: [{ text: r.text }]
    }));
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

    return collection
        .find({
            userId: userId,
            timestamp: {
                $gte: startOfDay,
                $lte: endOfDay
            }
        })
        .sort({ timestamp: 1 }) // oldest → newest (chronological order)
        .toArray();
}

/**
 * Returns structured chat history for ai.chats.create({ history }).
 */
export default async function chatHistoryKnowledge(userId) {
    const records = await fetchTodayChatRecords(userId);
    return formatChatHistoryForGemini(records);
}
