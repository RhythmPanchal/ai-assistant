import { createRecord } from "../tools/mongo/createRecord.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import { toIST } from "../tools/mongo/dateUtils.js";

export async function createOneTimeReminder(title, userId, nextExecutionAt, message) {
  const record = {
    title,
    userId,
    type: "one_time",
    recurring: false,
    cronPattern: null,
    timeZone: "Asia/Kolkata",
    actionType: "sendMessage",
    payload : {
        chatId : 1136575387,
        text : "[*REMINDER*]" + message
    },
    status: "active",
    attempts: 0,
    maxAttempts: 3,
    lastExecutedAt: null,
    nextExecutionAt: toIST(nextExecutionAt),
    expiryDate: null,
    failedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  console.log(record);
  return await createRecord( TRIGGER_JOB, record);
}

export async function createMultiTimeReminder(title, userId, cron, nextExecutionAt, message, expiryDate){
  const record = {
    title,
    userId,
    type: "recurring",
    recurring: true,
    cronPattern: cron,
    timeZone: "Asia/Kolkata",
    actionType: "sendMessage",
    payload : {
        chatId : 1136575387,
        text : "[*REMINDER*]" + message
    },
    status: "active",
    attempts: 0,
    maxAttempts: 3,
    lastExecutedAt: null,
    nextExecutionAt: toIST(nextExecutionAt),
    expiryDate: toIST(expiryDate),
    failedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  console.log(record);
  return await createRecord( TRIGGER_JOB, record);
}