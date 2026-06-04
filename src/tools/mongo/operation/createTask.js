import { createRecord } from "../createRecord.js";
import { TASK_CALENDAR } from "../schema/taskCalendarSchema.js";
import { toIST } from "../dateUtils.js";

export async function createTask(userId, title, requiredMinutes, importance, priorityScore, category, deadline, recurring) {
    // Validate required fields before attempting to insert
    if (!userId) {
        return { success: false, error: "userId is required to create a task." };
    }
    if (!title || title.trim() === "") {
        return { success: false, error: "title is required to create a task." };
    }

    const record = {
        userId,
        title: title.trim(),
        requiredMinutes: requiredMinutes || null,
        importance: importance || null,
        priorityScore: priorityScore || null,
        category: category || null,
        deadline: deadline ? toIST(deadline) : null,
        status: "Pending",
        recurring: recurring || null,
        scheduledEventId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    console.log("[createTask] Inserting into taskCalendar:", record);
    return await createRecord(TASK_CALENDAR, record);
}
