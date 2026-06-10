import chatHistorySchema, { CHAT_HISTORY } from "./schema/chatHistorySchema.js";
import taskCalendarSchema, { TASK_CALENDAR } from "./schema/taskCalendarSchema.js";
import triggerJobSchema, { TRIGGER_JOB } from "./schema/triggerJobSchema.js";
import expenseRegisterSchema, { EXPENSE_REGISTER } from "./schema/expenseRegisterSchema.js";
import tasksRegisterSchema, { TASK_REGISTER } from "./schema/taskRegisterSchema.js";
import dietRegisterSchema, { DIET_REGISTER } from "./schema/dietRegisterSchema.js";
import userScheduleSchema, { USER_SCHEDULE } from "./schema/userScheduleSchema.js";
import usersSchema, { USERS } from "./schema/usersSchema.js";

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
    [USERS]: {
        collectionName: "users",
        schema: usersSchema,
        writeable: true
    },
});

export default function fetchCollectionNameAndSchema() {
    return COLLECTION_REGISTRY;
}