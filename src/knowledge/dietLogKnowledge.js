import { getDB } from "../tools/mongo/mongoClient.js";
import { datesForModel } from "../tools/mongo/dateUtils.js";
import { DIET_REGISTER } from "../tools/mongo/schema/dietRegisterSchema.js";

function formatDietLogsForLLM(records) {
    const cleanData = (Array.isArray(records) ? records : [records]).map(item => {
        const { _id, createdAt, updatedAt, month, year, ...cleanItem } = item;

        // datesForModel, not toISOString().split("T")[0]. Rows are stored at IST
        // midnight, which is the previous day in UTC — so that slice dated every
        // logged day one day early, in the data the morning routine plans from.
        return datesForModel(cleanItem);
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