import { getDB } from "../tools/mongo/mongoClient.js";
import { TASK_CALENDAR } from "../tools/mongo/schema/taskCalendarSchema.js";

function formatPendingTaskforLLM(records){
    const cleanData = (Array.isArray(records) ? records : [records]).map(item => {
        //Destructure to REMOVE unwanted metadata
        const { _id, createdAt, updatedAt, scheduledEventId, ...cleanItem } = item;
        if (cleanItem.deadline) {
            cleanItem.deadline = new Date(cleanItem.deadline).toISOString().split('T')[0];
        }
        return cleanItem;
    });

    // Stringify with ZERO whitespace for maximum token efficiency
    return JSON.stringify(cleanData);
}

export default async function pendingTasksKnowledge(userId) {
    const db = await getDB();
    const collection = db.collection(TASK_CALENDAR);
    
    const records = await collection
        .find({
            userId: userId,
            status : "Pending"
        })
        .sort({ priorityScore : 1 }) // most prior -> least prior
        .toArray();
    
    return formatPendingTaskforLLM(records);
}
