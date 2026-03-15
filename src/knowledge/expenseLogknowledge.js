import { getDB } from "../tools/mongo/mongoClient.js";
import { EXPENSE_REGISTER } from "../tools/mongo/schema/expenseRegisterSchema.js";

function formatExpensesForLLM(records) {
    const cleanData = (Array.isArray(records) ? records : [records]).map(item => {
        const { _id, createdAt, __v, ...cleanItem } = item;
        if (cleanItem.date) {
            cleanItem.date = new Date(cleanItem.date).toISOString().split('T')[0];
        }
        return cleanItem;
    });

    return JSON.stringify(cleanData);
}

export default async function expenseLogKnowledge(userId) {
    const db = await getDB();
    const collection = db.collection(EXPENSE_REGISTER);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);       // e.g., 2026-03-01 00:00:00
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1); // e.g., 2026-04-01 00:00:00

    const records = await collection
        .find({
            userId: userId,
            date: {
                $gte: startOfMonth,
                $lt: startOfNextMonth
            }
        })
        .sort({ date: -1 }) // newest to oldest
        .toArray();

    return formatExpensesForLLM(records);
}