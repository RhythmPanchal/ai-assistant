export const USERS = "users";

// Bare schema + default export, matching every other file here. createCollection
// reads module.default and applies the validator/$jsonSchema wrapper itself.
const usersSchema = {
  title: "users",
  description: "Per-user profile, preferences, and optional own-model API keys.",
  bsonType: "object",
  properties: {
    // Permissive like connectionSchema: the driver may write a JS number as
    // int32 or int64 and a mismatch here surfaces as an opaque write failure.
    userId: {
      bsonType: ["int", "long"],
      description: "Telegram chat ID (unique).",
    },
    name: { bsonType: "string", description: "Preferred name." },
    age: { bsonType: ["int", "string", "null"] },
    profession: { bsonType: ["string", "null"] },
    dailySchedule: {
      bsonType: ["string", "null"],
      description: "Free-text description of a typical day.",
    },
    lifestyle: { bsonType: ["string", "null"] },
    timezone: {
      bsonType: "string",
      description: "IANA zone, e.g. 'Asia/Kolkata'. Drives when routines fire.",
    },
    apiKeys: {
      bsonType: ["object", "null"],
      description:
        "User's own provider keys, tried before the internal env keys. STORED IN PLAINTEXT TODAY — encrypt at rest before onboarding anyone else.",
      properties: {
        gemini: { bsonType: ["string", "null"] },
        groq: { bsonType: ["string", "null"] },
        openrouter: { bsonType: ["string", "null"] },
        ollama: { bsonType: ["string", "null"] },
      },
    },
    preferences: {
      bsonType: ["object", "null"],
      properties: {
        triggersOptIn: {
          bsonType: "bool",
          description: "Whether goodMorning / goodNight routines fire for this user.",
        },
      },
    },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
  required: ["userId", "name", "createdAt", "updatedAt"],
};

export default usersSchema;
