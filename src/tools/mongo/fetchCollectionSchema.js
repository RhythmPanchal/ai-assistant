import chatHistorySchema, { CHAT_HISTORY } from "./schema/chatHistorySchema.js";
import chatSummarySchema, { CHAT_SUMMARY } from "./schema/chatSummarySchema.js";
import taskCalendarSchema, { TASK_CALENDAR } from "./schema/taskCalendarSchema.js";
import triggerJobSchema, { TRIGGER_JOB } from "./schema/triggerJobSchema.js";
import expenseRegisterSchema, { EXPENSE_REGISTER } from "./schema/expenseRegisterSchema.js";
import tasksRegisterSchema, { TASK_REGISTER } from "./schema/taskRegisterSchema.js";
import dietRegisterSchema, { DIET_REGISTER } from "./schema/dietRegisterSchema.js";
import userScheduleSchema, { USER_SCHEDULE } from "./schema/userScheduleSchema.js";

// Built once at module load. Schemas are static — there's no reason to
// rebuild this object on every createRecord / updateRecords / fetch call.
const COLLECTION_REGISTRY = Object.freeze({
    [CHAT_HISTORY]: {
        collectionName: "chatHistory",
        schema: chatHistorySchema,
        writeable: true
    },
    [TASK_CALENDAR]: {
        collectionName: "taskCalendar",
        schema: taskCalendarSchema,
        writeable: true
    },
    [TRIGGER_JOB]: {
        collectionName: "triggerJob",
        schema: triggerJobSchema,
        writeable: true
    },
    [EXPENSE_REGISTER]: {
        collectionName: "expenseRegister",
        schema: expenseRegisterSchema,
        writeable: true
    },
    [TASK_REGISTER]: {
        collectionName: "taskRegister",
        schema: tasksRegisterSchema,
        writeable: true
    },
    [DIET_REGISTER]: {
        collectionName: "dietRegister",
        schema: dietRegisterSchema,
        writeable: true
    },
    [USER_SCHEDULE]: {
        collectionName: "userSchedule",
        schema: userScheduleSchema,
        writeable: true
    },
    // Registered so the summarize overlay can write it with the plain
    // createRecord tool — the same move the goodNight overlay makes for the
    // three registers. A dedicated saveSummary tool would cost ~350 tokens of
    // declaration on every request to be used once a day.
    [CHAT_SUMMARY]: {
        collectionName: "chatSummary",
        schema: chatSummarySchema,
        writeable: true
    }
});

export default function fetchCollectionNameAndSchema() {
    return COLLECTION_REGISTRY;
}