import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";

function formatChatHistoryForLLM(records) {
    return records
        .map(r => `${r.role.toUpperCase()}: ${r.text}`)
        .join("\n");
}

export default async function chatHistoryKnowledge(userId) {
    if (!userId) {
        throw new Error("userId is required to fetch chat history");
    }
    
    const db = await getDB();
    const collection = db.collection(CHAT_HISTORY);

    // Get today's date range (local day)
    const startOfDay = new Date();
    // startOfDay.setDate(startOfDay.getDate()-1);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    
    const records = await collection
        .find({
            userId: userId,
            timestamp: {
                $gte: startOfDay,
                $lte: endOfDay
            }
        })
        .sort({ timestamp: 1 }) // oldest → newest
        .toArray();
    
    return formatChatHistoryForLLM(records);
}
