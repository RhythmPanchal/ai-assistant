import { createRecord } from "../tools/mongo/createRecord.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";

export async function createOneTimeReminder({ title, userId, nextExecutionAt, message }) {
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
        message : message
    },
    status: "active",
    attempts: 0,
    maxAttempts: 3,
    lastExecutedAt: null,
    nextExecutionAt: new Date(nextExecutionAt),
    expiryDate: null,
    failedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  console.log(record);
  return await createRecord({collectionName : TRIGGER_JOB, data : record});
}