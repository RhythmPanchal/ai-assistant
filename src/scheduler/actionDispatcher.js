import { createRecord } from "../tools/mongo/createRecord.js";
import { updateRecords } from "../tools/mongo/updateRecord.js";
import { deleteRecord } from "../tools/mongo/deleteRecord.js";
import { fetchRecord } from "../tools/mongo/fetchRecords.js";
import { sendMessage } from "../tools/telegram/sendMessage.js";
import { sendToUser } from "../tools/telegram/sendToUser.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { createOneTimeReminder, createMultiTimeReminder } from "./createReminders.js";
import { cancelReminder } from "./cancelReminder.js";
import { createTask } from "../tools/mongo/operation/createTask.js";
import { insertSchedule } from "../tools/mongo/operation/insertSchedule.js";
import { goodMorningJob } from "./jobs/goodMorningJob.js";
import { goodNightJob } from "./jobs/goodNightJob.js";
import { summarizeDayJob } from "./jobs/summarizeDayJob.js";
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

  // cancelReminder(id, userId, reason) — order matters, dispatchAction spreads
  // these positionally.
  cancelReminder: {
    fn: cancelReminder,
    params: ["id", "userId", "reason"]
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

  deleteRecord: {
    fn: deleteRecord,
    params: ["collectionName", "id", "userId", "reason"]
  },

  fetchRecord: {
    fn: fetchRecord,
    params: ["collection", "filters", "sortBy", "sortOrder", "limit"]
  },

  // Takes a raw chat id. Kept because triggerJob rows written before the
  // identity split still carry actionType "sendMessage" with a baked-in
  // payload.chatId, and they must keep firing.
  sendMessage: {
    fn: sendMessage,
    params: ["chatId", "text"]
  },

  // Takes an internal userId and resolves the address at fire time. What new
  // reminders use.
  sendToUser: {
    fn: sendToUser,
    params: ["userId", "text"]
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

  // summarizeDayJob(userId, logDate, timeZone) — spread positionally, so this
  // order is the signature. Queued by scheduleDaySummary when the goodNight
  // flow closes, never by the model.
  summarizeDayJob: {
    fn: summarizeDayJob,
    params: ["userId", "logDate", "timeZone"]
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