export const USERS = "users";

/**
 * The model's notes about a person, one short paragraph per section.
 *
 * Section NAMES are fixed; their CONTENT is free text the model writes and
 * rewrites. That split is the whole design. Free content is what lets the notes
 * read like something a friend would remember rather than a form. Fixed names
 * are what stop the model filing the same thing under "goals" one week and
 * "ambitions" the next — the same drift that made open-ended fact keys need a
 * whole vocabulary to police them.
 *
 * `holds` is not just documentation: the updateNotes declaration is built from
 * it, so the model is told what belongs in each section in exactly these words.
 */
export const NOTE_SECTIONS = Object.freeze([
  { key: "about",          label: "About",      holds: "who they are: work, where they live, background, household, constraints to respect" },
  { key: "routine",        label: "Routine",    holds: "the shape of a normal day as it actually happens: waking, meals, work hours, sleep" },
  { key: "habits",         label: "Habits",     holds: "practices they want to keep up, and how that is actually going" },
  { key: "shortTermGoals", label: "Short-term", holds: "what they are working towards over the next weeks or months, and why" },
  { key: "longTermGoals",  label: "Long-term",  holds: "where they want their life to go, including directions that pull against each other" },
  { key: "behaviour",      label: "Behaviour",  holds: "patterns you have noticed, and how they like to be spoken to and pushed" },
]);

/**
 * Characters per section. A model-write policy, NOT a data invariant — it is
 * deliberately absent from the $jsonSchema below.
 *
 * Notes that grow a little every turn are how an agent's memory rots: nothing is
 * ever wrong enough to remove, so everything stays. A write over this limit is
 * refused with an instruction to rewrite shorter, which forces the model to
 * merge and prune instead of append. It is also what keeps replace-only writes
 * cheap — the model re-sends at most this much.
 *
 * Migrated data may exceed it: preserving what a user told us beats the cap, and
 * the next rewrite of that section has to come in under it anyway.
 */
export const NOTE_SECTION_LIMIT = 400;

const noteSectionSchema = {
  bsonType: "object",
  properties: {
    text: { bsonType: ["string", "null"], description: "The section as it stands. null once cleared." },
    previousText: {
      bsonType: ["string", "null"],
      description:
        "What the last rewrite replaced. One level only — enough to recover a goal a rewrite dropped by accident.",
    },
    updatedAt: { bsonType: ["date", "null"] },
  },
};

// Bare schema + default export, matching every other file here. createCollection
// reads module.default and applies the validator/$jsonSchema wrapper itself.
const usersSchema = {
  title: "users",
  description:
    "One document per person: the typed settings code acts on, and the notes the model keeps about them.",
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
    notes: {
      bsonType: "object",
      description:
        "The model's own notes on this person, rendered as WHO YOU ARE HELPING on every turn. Never null — a $set on notes.<section> cannot create a field inside a null.",
      properties: Object.fromEntries(NOTE_SECTIONS.map(({ key }) => [key, noteSectionSchema])),
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
 *  - updateNoteSection     — $set on one notes.<section>; the notes ride along
 *    on the getUserProfile read above, so rendering them costs no query
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
