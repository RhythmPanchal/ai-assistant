import { getDB } from "../tools/mongo/mongoClient.js";
import { datesForModel } from "../tools/mongo/dateUtils.js";
import { TASK_REGISTER } from "../tools/mongo/schema/taskRegisterSchema.js";

function formatTaskLogsForLLM(records) {
    const cleanData = (Array.isArray(records) ? records : [records]).map(item => {
        const { _id, userId, createdAt, updatedAt, ...cleanItem } = item;

        // datesForModel, not toISOString().split("T")[0]. Rows are stored at IST
        // midnight, which is the previous day in UTC — so that slice dated every
        // logged day one day early, in the data the morning routine plans from.

        // taskId is KEPT. It used to be stripped here, on the same token-thrift
        // reasoning that removed _id from the pending list — and with the same
        // result: the one field that links what was done to what was planned
        // never reached the model, so nothing could ever be reconciled.
        return datesForModel(cleanItem);
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