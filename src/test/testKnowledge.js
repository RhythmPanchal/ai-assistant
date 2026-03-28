import "dotenv/config";
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js";
import pendingTasksKnowledge from "../knowledge/pendingTasksKnowledge.js";
import expenseLogKnowledge  from "../knowledge/expenseLogknowledge.js";
import taskLogKnowledge from "../knowledge/taskLogKnowledge.js";
import dietLogKnowledge from "../knowledge/dietLogKnowledge.js";

const userId = 1136575387;

// const chatRecords = await chatHistoryKnowledge(userId);
// console.log("CHAT RECORDS FETCHED: ", chatRecords);

const pendingTasks = await pendingTasksKnowledge(userId) 
console.log("PENDING TASK RECORDS FETCHED :" , pendingTasks);

// let expenseLogs = await expenseLogKnowledge(userId); 
// console.log("THIS MONTH EXPENSE RECORDS FETCHED :" , expenseLogs);

// const taskLogs = await taskLogKnowledge(userId); 
// console.log("LAST 7 DAYS TASKS RECORDS FETCHED :" , taskLogs);

// const dietLogs = await dietLogKnowledge(userId); 
// console.log("LAST 7 DAYS DIET RECORDS FETCHED :" , dietLogs);