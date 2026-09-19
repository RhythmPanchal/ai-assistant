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
 * That is why about and routine spell out their boundary: a months-long parking
 * hunt, filed as a routine in the old fact store, was carried into prod's
 * Routine note as the whole of someone's day.
 */
export const NOTE_SECTIONS = Object.freeze([
  { key: "about",          label: "About",      holds: "who they are and their circumstances: work, where they live, background, household, health, constraints to respect, and situations that last for months, like a house move or an injury" },
  { key: "routine",        label: "Routine",    holds: "the shape of a normal day as it actually happens: waking, meals, work hours, exercise, sleep. Only what repeats — never a situation, a plan or an errand" },
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

/**
 * Local hour each routine fires for anyone who has not chosen their own
 * (preferences.morningHour / nightHour). Here rather than in initCron so the
 * profile block can show a user their times without importing the scheduler,
 * which imports the agent, which imports the profile block.
 */
export const ROUTINE_HOURS = Object.freeze({ morning: 9, night: 23 });

/**
 * The sections a routine may raise unprompted — the ones about where someone is
 * trying to get to. About, routine and behaviour describe them; there is
 * nothing in them to fall behind on.
 */
export const NUDGEABLE_SECTIONS = Object.freeze(["habits", "shortTermGoals", "longTermGoals"]);

/**
 * Minimum days between two unprompted goal nudges, across BOTH routines.
 *
 * This is the whole of "every day nudging is very bad", enforced in code rather
 * than asked of the model. A model told to raise goals "rarely" in a routine
 * that runs twice a day raises them twice a day; a claim that can only succeed
 * once a week cannot.
 */
export const NUDGE_COOLDOWN_DAYS = 7;

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
        "When onboarding first completed. null means it never finished: /start runs the first-time setup, and routines cannot be switched on. Set once, by markOnboarded.",
    },
    welcomedAt: {
      bsonType: ["date", "null"],
      description:
        "When the one welcome message was sent. Separate from onboardedAt so an abandoned onboarding resumed later is not welcomed twice.",
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
          description:
            "Whether goodMorning / goodNight routines fire for this user. false at signup; switched on when onboarding finishes, unless they chose otherwise.",
        },
        routinesChosenAt: {
          bsonType: ["date", "null"],
          description:
            "When the user last turned routines on or off themselves. Present means an explicit choice, which onboarding's completion must not override.",
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
        dayStartHour: {
          bsonType: ["int", "null"],
          minimum: 0,
          maximum: 23,
          description:
            "Local hour this person's day rolls over, deciding which turns count as one conversation. NOT when a routine fires — a wrap-up answered at 00:42 belongs to the day before. Falls back to DAY_START_HOUR (04:00) when null.",
        },
      },
    },
    notes: {
      bsonType: "object",
      description:
        "The model's own notes on this person, rendered as WHO YOU ARE HELPING on every turn. Never null — a $set on notes.<section> cannot create a field inside a null.",
      properties: {
        ...Object.fromEntries(NOTE_SECTIONS.map(({ key }) => [key, noteSectionSchema])),
        lastNudgedAt: {
          bsonType: ["date", "null"],
          description:
            "When a routine was last allowed to raise a goal unprompted. Written only by claimNudge, never by the model.",
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
 * REMOVED as typed fields: age, profession, dailySchedule, lifestyle. They were
 * free prose that no code ever read. That kind of thing belongs in `notes`,
 * which the model rewrites — a typed field for it is one nothing updates and
 * the prompt asserts forever. Nothing enforces their absence ($jsonSchema
 * allows extra fields), so this note is the only thing stopping them being
 * re-added at the top level.
 */
export const USERS_INDEXES = [
  { key: { userId: 1 }, name: "userId_1", unique: true },
  { key: { "preferences.triggersOptIn": 1 }, name: "preferences.triggersOptIn_1" },
];
