import { createRecord } from "../createRecord.js";
import { getDB } from "../mongoClient.js";
import { TASK_CALENDAR } from "../schema/taskCalendarSchema.js";
import { toIST } from "../dateUtils.js";
import { isRoutineBlock, routineBlockRefusal } from "./routineBlock.js";

/**
 * Two things are refused at this door, because taskCalendar has no way to
 * recover from either once they are in.
 *
 * A DUPLICATE is permanent. `Automation/agent for permission issues` was created
 * twice on 2026-08-12 and both rows were still Pending seventeen days later,
 * appearing side by side in every morning draft. Six titles were duplicated this
 * way. The partial unique index that was supposed to prevent it cannot even be
 * built while those rows exist, so the guard has to be here as well as in the
 * index — the index is the backstop, this is the thing that actually runs.
 *
 * A ROUTINE BLOCK is worse than permanent: it is un-completable. "Personal time
 * / catch up" cannot be finished, so it stays Pending forever and is offered
 * again every weekend. See routineBlock.js.
 *
 * Both return success:false with an explanation aimed at the model rather than
 * throwing, so the turn continues and it can say something sensible.
 */

function normaliseTitle(title) {
    return String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function createTask(userId, title, requiredMinutes, importance, priorityScore, category, deadline, recurring) {
    if (!userId) {
        return { success: false, error: "userId is required to create a task." };
    }
    if (!title || title.trim() === "") {
        return { success: false, error: "title is required to create a task." };
    }

    const cleanTitle = title.trim();

    if (isRoutineBlock(cleanTitle)) {
        return { success: false, error: routineBlockRefusal(cleanTitle) };
    }

    const db = await getDB();
    const wanted = normaliseTitle(cleanTitle);
    const existing = (await db.collection(TASK_CALENDAR)
        .find({ userId, status: { $in: ["Pending", "Scheduled"] } })
        .toArray())
        .find(t => normaliseTitle(t.title) === wanted);

    if (existing) {
        // Deliberately not an error the model should route around. It asked for
        // this task to exist and it does — returning the id lets it carry on and
        // reference the row, which is usually what it wanted anyway.
        return {
            success: true,
            duplicate: true,
            insertedId: existing._id,
            message:
                `"${existing.title}" is already open (id ${existing._id}, status ${existing.status}) — ` +
                `nothing created. Use that id if you need to update or schedule it. ` +
                `If the user means a genuinely different piece of work, give it a title that says so.`,
        };
    }

    const record = {
        userId,
        title: cleanTitle,
        requiredMinutes: requiredMinutes || null,
        importance: importance || null,
        priorityScore: priorityScore || null,
        category: category || null,
        deadline: deadline ? toIST(deadline) : null,
        status: "Pending",
        recurring: recurring || null,
        scheduledEventId: null,
        completedAt: null,
        notes: null,
        deferCount: 0,
        originalDeadline: deadline ? toIST(deadline) : null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    console.log("[createTask] Inserting into taskCalendar:", record.title);
    return await createRecord(TASK_CALENDAR, record);
}
