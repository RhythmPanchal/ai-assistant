export const TASK_CALENDAR = "taskCalendar";

const taskCalendarSchema = {
  title: "taskCalendar",
  description: "Single task record to be scheduled or completed",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: "int",
      description: "Identifier for the user who owns the task"
    },

    title: {
      bsonType: "string"
    },

    requiredMinutes: {
      bsonType: ["int", "null"],
      minimum: 1,
      description: "Estimated time in minutes"
    },

    importance: {
      bsonType: ["string", "null"],
      enum: ["Low", "Medium", "High", null]
    },

    priorityScore: {
      bsonType: ["int", "null"],
      minimum: 1,
      maximum: 5
    },

    category: {
      bsonType: ["string", "null"]
    },

    deadline: {
      bsonType: ["date", "null"]
    },

    status: {
      bsonType: "string",
      enum: ["Pending", "Scheduled", "Completed", "Cancelled"]
    },

    recurring: {
      bsonType: ["string", "null"],
      enum: ["hourly", "daily", "weekly", "monthly", "annually", null]
    },

    scheduledEventId: {
      bsonType: ["string", "null"]
    },

    completedAt: {
      bsonType: ["date", "null"],
      description: "When this task left Pending. Set by updateTaskStatus, never by the model directly."
    },

    notes: {
      bsonType: ["string", "null"],
      description: "Running trail — why it was cancelled, why a deadline moved. Appended to, not overwritten."
    },

    deferCount: {
      bsonType: ["int", "null"],
      minimum: 0,
      description: "How many times the deadline has been pushed. The signal that a task is being avoided rather than scheduled."
    },

    originalDeadline: {
      bsonType: ["date", "null"],
      description: "The first deadline ever set. Kept when `deadline` moves, so 'you said the 10th' survives every deferral."
    },

    createdAt: {
      bsonType: "date"
    },

    updatedAt: {
      bsonType: "date"
    }
  },
  required: [
    "userId",
    "title",
    "status"
  ]
};

export default taskCalendarSchema;

/**
 * Serves:
 *  - pendingTasksKnowledge — find({ userId, status: "Pending" })
 *                            .sort({ priorityScore: 1 }), read every morning
 *  - fetchRecord           — { userId } and { userId, status }
 *
 * Field order is equality → sort, so the sort is satisfied by the index and
 * never needs an in-memory pass.
 *
 * The second index is the guard against the duplicate-task bug: on 2026-08-12
 * a clarifying question ("Dependence handled?") caused all five tasks to be
 * created a second time. Partial, so it only constrains OPEN work — finishing
 * a task and adding it again later is still allowed.
 */
export const TASK_CALENDAR_INDEXES = [
  { key: { userId: 1, status: 1, priorityScore: 1 }, name: "userId_1_status_1_priorityScore_1" },
  {
    key: { userId: 1, title: 1 },
    name: "userId_1_title_1_pending",
    unique: true,
    partialFilterExpression: { status: "Pending" },
  },
];
