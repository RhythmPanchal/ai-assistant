import { createRecord } from "../tools/mongo/createRecord.js";
import { sendMessage } from "../tools/telegram/sendMessage.js";
import { runAgent } from "../agent/agent.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { createOneTimeReminder } from "./createReminder.js";

export const ACTION_MAP = {
  createOneTimeReminder: {
    fn: createOneTimeReminder,
    params: ["title", "userId", "nextExecutionAt", "message"]
  },

  createRecord: {
    fn: createRecord,
    params: ["collectionName", "data"]
  },

  sendMessage: {
    fn: sendMessage,
    params: ["chatId", "text"]
  },

  fetchCollectionNameAndSchema: {
    fn: fetchCollectionNameAndSchema,
    params: []
  }
};

export async function dispatchAction(actionType, payload) {
  const action = ACTION_MAP[actionType];

  if (!action) {
    throw new Error(`[dispatchAction] Unknown actionType: "${actionType}"`);
  }

  const args = action.params.map(p => payload[p]);

  const res =  await action.fn(...args);
  return res === undefined ? true : res ; 
}