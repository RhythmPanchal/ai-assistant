import { createRecord } from "../tools/mongo/createRecord.js";
import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import { toIST } from "../tools/mongo/dateUtils.js";

// The executor claims anything with nextExecutionAt <= now, so a job created in
// the past fires on the very next tick. On 2026-08-13 the agent re-issued a 19:00
// reminder at 21:08 and it went off at 21:09.
function assertFuture(fireAt, raw) {
  if (!fireAt || isNaN(fireAt.getTime())) {
    throw new Error(`Invalid nextExecutionAt: "${raw}". Use naive local time, e.g. "2026-08-13T19:00:00".`);
  }
  if (fireAt.getTime() <= Date.now()) {
    const when = fireAt.toLocaleString("en-GB", { timeZone: "Asia/Kolkata" });
    throw new Error(
      `nextExecutionAt "${raw}" resolves to ${when} IST, which has already passed — ` +
      `a reminder set in the past fires immediately. Confirm the intended date and time with the user, ` +
      `then call again with a future value.`
    );
  }
}

/**
 * An identical still-pending reminder already exists. Re-issuing one is almost
 * always the model misreading an acknowledgement ("thanks, that's done now") as
 * a fresh request, so this is a no-op rather than an error.
 */
async function findDuplicate(userId, title, fireAt) {
  const db = await getDB();
  return db.collection(TRIGGER_JOB).findOne({
    userId,
    title,
    nextExecutionAt: fireAt,
    status: { $in: ["active", "processing"] },
  });
}

export async function createOneTimeReminder(title, userId, nextExecutionAt, message) {
  const fireAt = toIST(nextExecutionAt);
  assertFuture(fireAt, nextExecutionAt);

  const duplicate = await findDuplicate(userId, title, fireAt);
  if (duplicate) {
    return {
      success: true,
      duplicate: true,
      insertedId: duplicate._id,
      message: `A reminder "${title}" is already scheduled for that time — nothing to do.`,
    };
  }

  const record = {
    title,
    userId,
    type: "one_time",
    recurring: false,
    cronPattern: null,
    timeZone: "Asia/Kolkata",
    actionType: "sendToUser",
    payload : {
        userId,
        text : "[*REMINDER*]" + message
    },
    status: "active",
    attempts: 0,
    maxAttempts: 3,
    lastExecutedAt: null,
    nextExecutionAt: fireAt,
    expiryDate: null,
    failedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  console.log(record);
  return await createRecord( TRIGGER_JOB, record);
}

export async function createMultiTimeReminder(title, userId, cron, nextExecutionAt, message, expiryDate){
  const fireAt = toIST(nextExecutionAt);
  assertFuture(fireAt, nextExecutionAt);

  const duplicate = await findDuplicate(userId, title, fireAt);
  if (duplicate) {
    return {
      success: true,
      duplicate: true,
      insertedId: duplicate._id,
      message: `A recurring reminder "${title}" is already scheduled from that time — nothing to do.`,
    };
  }

  const record = {
    title,
    userId,
    type: "recurring",
    recurring: true,
    cronPattern: cron,
    timeZone: "Asia/Kolkata",
    actionType: "sendToUser",
    payload : {
        userId,
        text : "[*REMINDER*]" + message
    },
    status: "active",
    attempts: 0,
    maxAttempts: 3,
    lastExecutedAt: null,
    nextExecutionAt: fireAt,
    expiryDate: toIST(expiryDate),
    failedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  console.log(record);
  return await createRecord( TRIGGER_JOB, record);
}