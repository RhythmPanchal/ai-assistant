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
 * The reminder body, as an actual string.
 *
 * `"[*REMINDER*]" + message` stringifies whatever it is given, so an object
 * arrived as the literal text "[*REMINDER*][object Object]" and the user got
 * that on Telegram every night. Two such reminders ran daily from 2026-08-18
 * to 2026-08-30 before anyone could tell what they were meant to say.
 *
 * The tool description was the cause — it declared type "string" but gave
 * `{ message: '...' }` as the example, and the model copied the example. That
 * is fixed in RemindersTool.js; this rejects the shape outright so no future
 * wording can put an unreadable reminder in the database. Throwing beats
 * coercing: the error goes back to the model, which retries with a string.
 */
function reminderBody(message) {
  if (typeof message !== "string" || message.trim() === "") {
    throw new Error(
      `Invalid message: expected a non-empty string, got ${JSON.stringify(message)}. ` +
      `Pass the reminder sentence itself, e.g. "Call Masi" — not an object and not an empty value.`
    );
  }
  return "[*REMINDER*]" + message;
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
  const text = reminderBody(message);

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
        text,
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
  const text = reminderBody(message);

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
        text,
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