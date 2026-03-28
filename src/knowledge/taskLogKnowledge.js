import { getDB } from "../tools/mongo/mongoClient.js";
import { TASK_REGISTER } from "../tools/mongo/schema/taskRegisterSchema.js";

function formatTaskLogsForLLM(records) {
    const cleanData = (Array.isArray(records) ? records : [records]).map(item => {
        const { _id, userId, createdAt, ...cleanItem } = item;

        if (cleanItem.date) {
            cleanItem.date = new Date(cleanItem.date).toISOString().split('T')[0];
        }

        if (cleanItem.performedTasks) {
            cleanItem.performedTasks = cleanItem.performedTasks.map(task => {
                const { taskId, ...cleanTask } = task;
                return cleanTask;
            });
        }
        return cleanItem;
    });

    return JSON.stringify(cleanData);
}

export default async function taskLogKnowledge(userId) {
    const db = await getDB();
    const collection = db.collection(TASK_REGISTER);

    const now = new Date();
    const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7); // start of 7 days ago
    const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); // exclude future

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

    return formatTaskLogsForLLM(records);
}