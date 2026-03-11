import { createRecord } from "../tools/mongo/createRecord.js";
import { sendMessage } from "../tools/telegram/sendMessage.js";
import { runAgent } from "../agent/agent.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { createOneTimeReminder } from "./createReminder.js";

const ACTION_MAP = {
  createRecord,
  sendMessage,
  runAgent,
  fetchCollectionNameAndSchema,
  createOneTimeReminder
};

export async function dispatchAction(actionType, payload) {
  const actionFn = ACTION_MAP[actionType];

  if (!actionFn) {
    throw new Error(`[dispatchAction] Unknown actionType: "${actionType}"`);
  }

  const result = await actionFn(payload);
  if( result === undefined)return true; 
  return result;
}