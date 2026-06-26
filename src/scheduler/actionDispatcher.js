import { createRecord } from "../tools/mongo/createRecord.js";
import { updateRecords } from "../tools/mongo/updateRecord.js";
import { fetchRecord } from "../tools/mongo/fetchRecords.js";
import { sendMessage } from "../tools/telegram/sendMessage.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { createOneTimeReminder, createMultiTimeReminder } from "./createReminders.js";
import { createTask } from "../tools/mongo/operation/createTask.js";
import { insertSchedule } from "../tools/mongo/operation/insertSchedule.js";
import { goodMorningJob } from "./jobs/goodMorningJob.js";
import { goodNightJob } from "./jobs/goodNightJob.js";
import { completeFlow } from "./flows/completeFlow.js";
import { connectApp } from "../connectors/oauth/connectApp.js";
import { disconnectApp } from "../connectors/oauth/disconnectApp.js";

export const ACTION_MAP = {
  createOneTimeReminder: {
    fn: createOneTimeReminder,
    params: ["title", "userId", "nextExecutionAt", "message"]
  },

  createMultiTimeReminder: {
    fn: createMultiTimeReminder,
    params: ["title", "userId", "cron", "nextExecutionAt", "message", "expiryDate"]
  },

  createTask: {
    fn: createTask,
    params: ["userId", "title", "requiredMinutes", "importance", "priorityScore", "category", "deadline", "recurring"]
  },

  insertSchedule: {
    fn: insertSchedule,
    params: ["userId", "date", "slots", "summary", "motivationalNote"]
  },

  createRecord: {
    fn: createRecord,
    params: ["collectionName", "data"]
  },

  updateRecords: {
    fn: updateRecords,
    params: ["records"]
  },

  fetchRecord: {
    fn: fetchRecord,
    params: ["collection", "filters", "sortBy", "sortOrder", "limit"]
  },

  sendMessage: {
    fn: sendMessage,
    params: ["chatId", "text"]
  },

  fetchCollectionNameAndSchema: {
    fn: fetchCollectionNameAndSchema,
    params: []
  },

  goodMorningJob: {
    fn: goodMorningJob,
    params: []
  },

  goodNightJob: {
    fn: goodNightJob,
    params: []
  },

  completeFlow: {
    fn: completeFlow,
    params: ["userId", "flowType", "reason"]
  },

  connectApp: {
    fn: connectApp,
    params: ["userId", "appName"]
  },

  disconnectApp: {
    fn: disconnectApp,
    params: ["userId", "appName"]
  },

};

export async function dispatchAction(actionType, payload) {
  const action = ACTION_MAP[actionType];

  if (!action) {
    throw new Error(`[dispatchAction] Unknown actionType: "${actionType}"`);
  }

  const args = action.params.map(p => payload[p]);

  const res = await action.fn(...args);
  return res === undefined ? true : res;
}