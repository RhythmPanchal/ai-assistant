export const TASK_CALENDAR = "taskCalendar";

const taskCalendarSchema = {
  title: "taskCalendar",
  description: "Single task record to be scheduled or completed",
  bsonType: "object",
  properties: {
    _id: {
      bsonType: "string",
      description: "Unique task identifier"
    },

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

    createdAt: {
      bsonType: "date"
    },

    updatedAt: {
      bsonType: "date"
    }
  },
  required: [
    "id",
    "userId",
    "title",
    "status",
    "createdAt"
  ]
};

export default taskCalendarSchema;
