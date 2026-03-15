import { getDB } from "../tools/mongo/mongoClient.js";
import { DIET_REGISTER } from "../tools/mongo/schema/dietRegisterSchema.js";

function formatDietLogsForLLM(records) {
    const cleanData = (Array.isArray(records) ? records : [records]).map(item => {
        const { _id, createdAt, month, year, ...cleanItem } = item;

        if (cleanItem.date) {
            cleanItem.date = new Date(cleanItem.date).toISOString().split('T')[0];
        }

        return cleanItem;
    });

    return JSON.stringify(cleanData);
}

export default  async function dietLogKnowledge(userId) {
    const db = await getDB();
    const collection = db.collection(DIET_REGISTER);

    const now = new Date();
    const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const records = await collection
        .find({
            userId: userId,
            date: {
                $gte: sevenDaysAgo,
                $lt: startOfTomorrow
            }
        })
        .sort({ date: -1 }) // newest to oldest
        .toArray();

    return formatDietLogsForLLM(records);
}