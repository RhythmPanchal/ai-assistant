export const USERS = "users";

export const usersSchema = {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["userId", "name", "createdAt", "updatedAt"],
      properties: {
        userId: {
          bsonType: "long",
          description: "Telegram user ID (unique)",
        },
        name: {
          bsonType: "string",
          description: "User's full or preferred name",
        },
        age: {
          bsonType: ["int", "string"],
          description: "User's age",
        },
        profession: {
          bsonType: "string",
          description: "User's profession",
        },
        dailySchedule: {
          bsonType: "string",
          description: "General string describing their typical day",
        },
        lifestyle: {
          bsonType: "string",
          description: "Details about lifestyle, hobbies, etc.",
        },
        timezone: {
          bsonType: "string",
          description: "Timezone string, e.g. 'Asia/Kolkata'",
        },
        apiKeys: {
          bsonType: "object",
          description: "User-provided API keys",
          properties: {
            gemini: { bsonType: "string" },
            mistral: { bsonType: "string" },
            groq: { bsonType: "string" },
            openrouter: { bsonType: "string" },
            ollama: { bsonType: "string" },
            nvidia: { bsonType: "string" },
          }
        },
        preferences: {
          bsonType: "object",
          properties: {
            triggersOptIn: {
              bsonType: "bool",
              description: "Whether the user wants Good Morning / Good Night daily flows"
            }
          }
        },
        createdAt: {
          bsonType: "date",
          description: "Creation timestamp",
        },
        updatedAt: {
          bsonType: "date",
          description: "Last update timestamp",
        },
      },
    },
  },
};
