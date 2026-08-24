export const USERS = "users";

// Bare schema + default export, matching every other file here. createCollection
// reads module.default and applies the validator/$jsonSchema wrapper itself.
const usersSchema = {
  title: "users",
  description:
    "Per-user operational settings. Everything CODE reads lives here; narrative context the LLM reads lives in userFact.",
  bsonType: "object",
  properties: {
    // Permissive like connectionSchema: the driver may write a JS number as
    // int32 or int64 and a mismatch here surfaces as an opaque write failure.
    userId: {
      bsonType: ["int", "long"],
      description:
        "Internal incremental id, allocated from the counters collection. NOT a Telegram chat id — channel-specific ids belong in userIdentity.",
    },
    name: { bsonType: "string", description: "Preferred name." },
    timezone: {
      bsonType: "string",
      description: "IANA zone, e.g. 'Asia/Kolkata'. Drives when routines fire.",
    },
    locale: { bsonType: ["string", "null"], description: "BCP-47 tag, e.g. 'en-IN'." },
    currency: {
      bsonType: ["string", "null"],
      description:
        "ISO 4217 code the user thinks in day to day, e.g. 'INR'. expenseRegister stores a bare amount — this is its unit.",
    },
    status: {
      bsonType: "string",
      description: "Lifecycle. 'paused' stops routines without losing data.",
      enum: ["active", "paused", "deleted"],
    },
    enabledSkills: {
      bsonType: ["array", "null"],
      description:
        "Domain playbooks loaded for this user. Keeps a commerce user from paying prompt tokens for a developer playbook.",
      items: { bsonType: "string" },
    },
    onboardedAt: {
      bsonType: ["date", "null"],
      description:
        "When the onboarding flow completed. null means it never finished, so the flow may resume.",
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
        // Until these existed every user got the hardcoded ROUTINE_HOURS from
        // initCron.js — i.e. the original single user's hours.
        morningHour: {
          bsonType: ["int", "null"],
          minimum: 0,
          maximum: 23,
          description: "Local hour the morning routine fires. Falls back to ROUTINE_HOURS when null.",
        },
        nightHour: {
          bsonType: ["int", "null"],
          minimum: 0,
          maximum: 23,
          description: "Local hour the night routine fires. Falls back to ROUTINE_HOURS when null.",
        },
      },
    },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
  required: ["userId", "name", "createdAt", "updatedAt"],
};

export default usersSchema;

/**
 * Serves:
 *  - getUserProfile        — findOne({ userId }), on every agent turn since the
 *    profile is read before the flow overlays are built
 *  - resolveRoutineTargets — find({ "preferences.triggersOptIn": true }), the
 *    hourly routine executor's fan-out list
 *
 * unique on userId: it is the identity of the record, and upserts key on it.
 *
 * `timezone` is deliberately NOT required. The onboarding flow creates the row
 * at /start, before it has asked where the user lives; callers already fall back
 * to IST. Requiring it would mean either blocking signup on a question or
 * writing a guess that looks like a stated fact.
 *
 * REMOVED in the userFact split: age, profession, dailySchedule, lifestyle.
 * They were free prose that no code ever read, which is the definition of a
 * userFact row — they now live there as identity.*, work.role and routine.*.
 * Nothing enforces their absence ($jsonSchema allows extra fields), so this
 * note is the only thing stopping them being re-added here.
 */
export const USERS_INDEXES = [
  { key: { userId: 1 }, name: "userId_1", unique: true },
  { key: { "preferences.triggersOptIn": 1 }, name: "preferences.triggersOptIn_1" },
];
