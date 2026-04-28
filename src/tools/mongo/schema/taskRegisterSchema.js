export const TASK_REGISTER = "taskRegister"; 

const tasksRegisterSchema = {
  title: "tasksRegister",
  description: "Daily log of performed tasks",
  bsonType: "object",
  properties: {
    userId : {
      bsonType : "int", 
      description : "User Id who owns this task log"
    },
    date: {
      bsonType: "date",
      description: "Log date"
    },
    day: {
      bsonType: "string",
      description: "Day name"
    },
    performedTasks: {
      bsonType: "array",
      items: {
        bsonType: "object",
        properties: {
          taskId: { bsonType: "string" },
          title: { bsonType: "string" },
          category: { bsonType: "string" },
          actualFrom: {
            bsonType: "string",
            pattern: "^([01]\\d|2[0-3]):([0-5]\\d)$"
          },
          actualTo: {
            bsonType: "string",
            pattern: "^([01]\\d|2[0-3]):([0-5]\\d)$"
          },
          actualDurationMinutes: {
            bsonType: "int",
            minimum: 1
          },
          status: {
            bsonType: "string",
            enum: ["Completed", "Partial", "Skipped"]
          },
          focusLevel: {
            bsonType: "int",
            minimum: 1,
            maximum: 5
          },
          notes: { bsonType: "string" }
        },
        required: [
          "taskId",
          "title",
          "category",
          "status",
          "actualDurationMinutes"
        ]
      }
    },
    createdAt: {
      bsonType: "date"
    }
  },

  required: ["date", "day", "performedTasks"]
};

export default tasksRegisterSchema;
