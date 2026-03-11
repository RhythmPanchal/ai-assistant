import chatHistorySchema,{ CHAT_HISTORY }  from "./schema/chatHistorySchema.js";
import taskCalendarSchema, { TASK_CALENDAR } from "./schema/taskCalendarSchema.js";
import triggerJobSchema, { TRIGGER_JOB } from "./schema/triggerJobSchema.js";

export default function fetchCollectionNameAndSchema(){
    
    return { 
        [CHAT_HISTORY] : {
            collectionName : "chatHistory", 
            schema : chatHistorySchema, 
            writeable : true
        },
        [TASK_CALENDAR] : {
            collectionName : "taskCalendar",
            schema : taskCalendarSchema,
            writeable : true
        },
        [TRIGGER_JOB] : {
            collectionName : "triggerJob", 
            schema : triggerJobSchema,
            writeable : true
        }
    }
}