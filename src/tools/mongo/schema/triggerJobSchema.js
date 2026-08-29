export const TRIGGER_JOB = "triggerJob";

const triggerJobSchema = {
  title: "triggerJob",
  description: "Background scheduler job for reminders, daily planning, and recurring triggers.",
  bsonType: "object",
  properties: {
    title: {
      bsonType: "string",
      description: "Human-readable title for this trigger job."
    },

    userId: {
      bsonType: "int",
      description: "Identifier of the user who owns this trigger job."
    },

    type: {
      bsonType: "string",
      description: "Indicates whether the job runs once or repeatedly.",
      enum: ["one_time", "recurring"]
    },

    recurring: {
        bsonType: "boolean", 
        description: "true if the job is recurring, false if one time." 
    },

    cronPattern: {
      bsonType: ["string", "null"],
      description: "Cron pattern used only for recurring jobs."
    },

    timeZone: {
      bsonType: "string",
      description: "Timezone for execution (e.g., Asia/Kolkata)."
    },

    actionType: {
      bsonType: "string",
      description: "Defines what action to execute (e.g., runAgent, sendMessage)."
    },

    payload: {
      bsonType: "object",
      description: "Arguments required for executing the action."
    },

    status: {
      bsonType: "string",
      description: "Current lifecycle state of the job.",
      enum: ["active", "processing", "completed", "failed", "cancelled"]
    },

    attempts: {
      bsonType: "int",
      description: "Number of execution attempts made.",
      minimum: 0
    },

    maxAttempts: {
      bsonType: "int",
      description: "Maximum retry attempts allowed, default is 3.",
      minimum: 1
    },

    lastExecutedAt: {
      bsonType: ["date", "null"],
      description: "Timestamp of last execution."
    },

    nextExecutionAt: {
      // Nulled once a job reaches a terminal state — there is no next run. The
      // declared type was "date" only, which every completion write violated;
      // it went unnoticed because the deployed collections carry no validator,
      // so a fresh database built from this file would have started rejecting
      // writes that the running system makes constantly.
      bsonType: ["date", "null"],
      description: "Next scheduled execution time. Null once the job is terminal."
    },

    expiryDate: {
      bsonType: ["date", "null"],
      description: "Expiry time after which the job stops running. Enforced by " +
        "triggerExecutor (which retires expired jobs) and by scheduleNextRun " +
        "(which will not reschedule past it). Null means run indefinitely."
    },

    failedAt: {
      bsonType: ["date", "null"],
      description: "Timestamp when job execution failed."
    },

    createdAt: {bsonType: "date"},
    updatedAt: {bsonType: "date"}
  },

  required: [
    "title",
    "userId",
    "type",
    "timeZone",
    "actionType",
    "status",
    "nextExecutionAt"
  ]
};

export default triggerJobSchema;

/**
 * Serves:
 *  - triggerExecutor — find({ status: "active", nextExecutionAt: {$lte: now} })
 *    plus an expiryDate guard, which runs EVERY MINUTE, forever. The hottest
 *    query in the system and the one most worth indexing: without it each tick
 *    is a full collection scan. Equality on status first, then the range — an
 *    index can only range-scan on its last used field. expiryDate stays out of
 *    the key: it filters a handful of already-narrowed rows.
 *  - triggerExecutor's expiry sweep — updateMany({ status: "active",
 *    expiryDate: {$ne: null, $lte: now} }), same tick, served by the status
 *    prefix of the same index.
 *  - createReminders.findDuplicate — { userId, title, nextExecutionAt, status }
 */
export const TRIGGER_JOB_INDEXES = [
  { key: { status: 1, nextExecutionAt: 1 }, name: "status_1_nextExecutionAt_1" },
  { key: { userId: 1, title: 1, nextExecutionAt: 1 }, name: "userId_1_title_1_nextExecutionAt_1" },
];