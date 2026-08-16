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
      bsonType: "date",
      description: "Next scheduled execution time."
    },

    expiryDate: {
      bsonType: ["date", "null"],
      description: "Optional expiry time after which job should not run."
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
 *  - triggerExecutor — find({ status: "active", nextExecutionAt: {$lte: now} }),
 *    which runs EVERY MINUTE, forever. The hottest query in the system and the
 *    one most worth indexing: without it each tick is a full collection scan.
 *    Equality on status first, then the range — an index can only range-scan on
 *    its last used field.
 *  - createReminders.findDuplicate — { userId, title, nextExecutionAt, status }
 */
export const TRIGGER_JOB_INDEXES = [
  { key: { status: 1, nextExecutionAt: 1 }, name: "status_1_nextExecutionAt_1" },
  { key: { userId: 1, title: 1, nextExecutionAt: 1 }, name: "userId_1_title_1_nextExecutionAt_1" },
];