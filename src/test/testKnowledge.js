import "dotenv/config";
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js";
import pendingTasksKnowledge from "../knowledge/pendingTasksKnowledge.js";

const userId = 1136575387;

const chatRecords = await chatHistoryKnowledge(userId);
console.log("CHAT RECORDS FETCHED: ", chatRecords);

const pendingTasks = await pendingTasksKnowledge("123") 
console.log("PENDING TASK RECORDS FETCHED :" , formatPendingTaskforLLM(pendingTasks));

