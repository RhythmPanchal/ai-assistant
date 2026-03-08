import "dotenv/config";
import {getNextCronDate} from "../scheduler/executeTriggerJob.js"
import { dispatchAction } from "../scheduler/actionDispatcher.js";

// console.log(getNextCronDate("30 3 * * *", "UTC")); 

//next time to execute from cron function test 
console.log(getNextCronDate("* * * * *", "Asia/Kolkata"));

//dispatch action function 
const testDispatchedActions = [
  {
    "actionType" : "sendMessage",
    "payload" : {
      "chatId" : 1136575387,
      "message" : "Hello this is test message"
    }
  },
  {
    "actionType" : "runAgent",
    "payload" : {
      "userId" : 1136575387, 
      "userInstruction" : "Hello, who are you?"
    }
  }
]

for(const actions of testDispatchedActions){
  console.log(`n-------- Testing : ${actions.actionType} -----`);
  try{
    console.log(actions.actionType);
    console.log(actions.payload); 
    await dispatchAction(actions.actionType, actions.payload);
  } catch (err) {
    console.error(` [TEST] Caught error for ${actions.actionType} :` , err.message); 
  }
}

//actual job execution. 
// const testJobs = [
//   // ─── 1. Happy path — one_time job, succeeds on first attempt ─────────────
//   {
//     _id: new ObjectId(),
//     title: "One Time Success",
//     userId: "user_001",
//     type: "one_time",
//     recurring: false,
//     cronPattern: null,
//     timeZone: "Asia/Kolkata",
//     actionType: "sendMessage",
//     payload: { message: "Hello!" },
//     status: "active",
//     attempts: 0,
//     maxAttempts: 3,
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },

//   // ─── 2. Happy path — recurring job, succeeds ─────────────────────────────
//   {
//     _id: new ObjectId(),
//     title: "Recurring Success",
//     userId: "user_001",
//     type: "recurring",
//     recurring: true,
//     cronPattern: "*/30 * * * *",
//     timeZone: "Asia/Kolkata",
//     actionType: "sendMessage",
//     payload: { message: "Daily ping" },
//     status: "active",
//     attempts: 0,
//     maxAttempts: 3,
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },

//   // ─── 3. Job is not active — should throw and skip ────────────────────────
//   {
//     _id: new ObjectId(),
//     title: "Already Processing",
//     userId: "user_001",
//     type: "one_time",
//     recurring: false,
//     cronPattern: null,
//     timeZone: "Asia/Kolkata",
//     actionType: "sendMessage",
//     payload: {},
//     status: "processing", // not active — findOneAndUpdate will return null
//     attempts: 0,
//     maxAttempts: 3,
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },

//   // ─── 4. One time job — fails but retries remaining ────────────────────────
//   {
//     _id: new ObjectId(),
//     title: "One Time Retry",
//     userId: "user_001",
//     type: "one_time",
//     recurring: false,
//     cronPattern: null,
//     timeZone: "Asia/Kolkata",
//     actionType: "failingAction", // this action should throw in your dispatchAction
//     payload: {},
//     status: "active",
//     attempts: 1,        // 1 attempt already done, 2 remaining
//     maxAttempts: 3,
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },

//   // ─── 5. One time job — fails and max attempts exceeded → permanent fail ───
//   {
//     _id: new ObjectId(),
//     title: "One Time Permanent Fail",
//     userId: "user_001",
//     type: "one_time",
//     recurring: false,
//     cronPattern: null,
//     timeZone: "Asia/Kolkata",
//     actionType: "failingAction",
//     payload: {},
//     status: "active",
//     attempts: 2,        // already at maxAttempts - 1, next failure = permanent
//     maxAttempts: 3,
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },

//   // ─── 6. Recurring job — fails and max attempts exceeded → skip to next run─
//   {
//     _id: new ObjectId(),
//     title: "Recurring Max Fail Skip",
//     userId: "user_001",
//     type: "recurring",
//     recurring: true,
//     cronPattern: "*/30 * * * *",
//     timeZone: "Asia/Kolkata",
//     actionType: "failingAction",
//     payload: {},
//     status: "active",
//     attempts: 2,        // hits maxAttempts, should reschedule not die
//     maxAttempts: 3,
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },

//   // ─── 7. Recurring job — invalid cron pattern ─────────────────────────────
//   {
//     _id: new ObjectId(),
//     title: "Invalid Cron",
//     userId: "user_001",
//     type: "recurring",
//     recurring: true,
//     cronPattern: "invalid-cron",
//     timeZone: "Asia/Kolkata",
//     actionType: "sendMessage",
//     payload: {},
//     status: "active",
//     attempts: 0,
//     maxAttempts: 3,
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },

//   // ─── 8. Job with missing maxAttempts — should fallback to default 3 ───────
//   {
//     _id: new ObjectId(),
//     title: "No maxAttempts",
//     userId: "user_001",
//     type: "one_time",
//     recurring: false,
//     cronPattern: null,
//     timeZone: "Asia/Kolkata",
//     actionType: "failingAction",
//     payload: {},
//     status: "active",
//     attempts: 0,
//     maxAttempts: null,  // missing — your ?? 3 fallback should kick in
//     lastExecutedAt: null,
//     nextExecutionAt: new Date(),
//     expiryDate: null,
//     failedAt: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   },
// ];

// for (const job of testJobs) {
//   console.log(`\n─── Testing: ${job.title} ───`);
//   try {
//     await executeTriggerJob(job);
//   } catch (err) {
//     console.error(`[TEST] Caught error for "${job.title}":`, err.message);
//   }
// }

