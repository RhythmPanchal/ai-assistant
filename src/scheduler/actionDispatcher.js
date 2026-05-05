import { createRecord } from "../tools/mongo/createRecord.js";
import { updateRecords } from "../tools/mongo/updateRecord.js";
import { fetchRecord } from "../tools/mongo/fetchRecords.js";
import { sendMessage } from "../tools/telegram/sendMessage.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { createOneTimeReminder } from "./createReminders.js";
import { createTask } from "../tools/mongo/operation/createTask.js";
import { insertSchedule } from "../tools/mongo/operation/insertSchedule.js";
import { goodMorningJob } from "./jobs/goodMorningJob.js";
import { goodNightJob } from "./jobs/goodNightJob.js";

export const ACTION_MAP = {
  createOneTimeReminder: {
    fn: createOneTimeReminder,
    params: ["title", "userId", "nextExecutionAt", "message"]
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
  }

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