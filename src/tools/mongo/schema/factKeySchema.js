export const FACT_KEY = "factKey";

// Bare schema + default export, matching every other file here. createCollection
// reads module.default and applies the validator/$jsonSchema wrapper itself.
const factKeySchema = {
  title: "factKey",
  description:
    "The vocabulary of userFact keys. Seeded from CORE_FACT_KEYS at boot, then grown at runtime by keys the extraction pass mints.",
  bsonType: "object",
  properties: {
    key: {
      bsonType: "string",
      description: "Lowercase dot-separated slug, e.g. 'work.status'.",
      pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$",
    },
    description: {
      bsonType: "string",
      description:
        "What belongs under this key. Doubles as documentation and as the instruction handed to the extraction model — write it as guidance, not as a label.",
    },
    origin: {
      bsonType: "string",
      description:
        "'core' was seeded from the code spine and is reviewed; 'emergent' was minted at runtime from a real conversation.",
      enum: ["core", "emergent"],
    },
    usageCount: {
      bsonType: "int",
      description:
        "How many distinct users hold a fact under this key. Drives promotion into the asking vocabulary.",
      minimum: 0,
    },
    firstSeenFrom: {
      bsonType: ["int", "null"],
      description: "userId whose conversation minted this key. null for core keys.",
    },
    promotedAt: {
      bsonType: ["date", "null"],
      description:
        "When this key entered the ASKING vocabulary. null means it is still match-only.",
    },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
  required: ["key", "description", "origin", "usageCount", "createdAt", "updatedAt"],
};

export default factKeySchema;

/**
 * TWO VOCABULARIES, built from this one collection. The split is the whole
 * design — collapsing them back into one breaks it in one direction or the other.
 *
 *  MATCHING  — every key, core and emergent, capped at VOCABULARY_LIMIT by
 *              usageCount. Injected into the extraction pass so the model reuses
 *              'education.certification' instead of minting 'studies.cert'.
 *              This one must be BROAD: a key the model cannot see is a key it
 *              will reinvent under a different name.
 *
 *  ASKING    — core keys plus emergent ones past PROMOTION_THRESHOLD. What the
 *              onboarding flow draws on when deciding what to ask a new user.
 *              This one must be NARROW: one user mentioning their CA exams is
 *              not a reason to interrogate everyone about certifications.
 *
 * Promotion is what moves a key from "reusable" to "worth asking about", gated
 * on evidence that it is common rather than idiosyncratic.
 *
 * An earlier version of this design hid emergent keys from other users until
 * usageCount crossed the threshold. That cannot work: a key nobody else can see
 * is a key nobody else can reuse, so the count never rises. Emergent keys are
 * visible for MATCHING from the moment they are minted.
 */
export const FACT_KEY_INDEXES = [
  { key: { key: 1 }, name: "key_1", unique: true },
  { key: { origin: 1, usageCount: -1 }, name: "origin_1_usageCount_-1" },
];

/**
 * Distinct users holding a key before it joins the ASKING vocabulary. Low on
 * purpose — three independent people is already evidence of a real category,
 * and a slow threshold means the registry never learns anything.
 */
export const PROMOTION_THRESHOLD = 3;

/**
 * Cap on the MATCHING vocabulary injected per extraction call. Without it every
 * key ever minted taxes every extraction prompt forever — a fixed cost traded
 * for an unbounded one.
 */
export const VOCABULARY_LIMIT = 120;

/**
 * Enforced in the write tool rather than by the $jsonSchema pattern alone, so a
 * rejected key can name the closest valid alternative instead of failing with an
 * opaque validation error — the same reasoning that gives ValidateSchema its
 * existence alongside Mongo's own validator.
 *
 * Normalising matters more than it looks: 'Work.Status', 'workStatus' and
 * 'work_status' are four spellings of one concept that the matching vocabulary
 * has no way to collapse after the fact.
 */
export const KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * The reviewed spine, materialised into `factKey` at boot the same way
 * INDEX_REGISTRY is materialised by ensureIndexes().
 *
 * Seeding from code rather than letting the whole vocabulary emerge is what
 * stops the first user's phrasing from becoming every later user's vocabulary.
 * Everything past this list is minted by the model from real conversations.
 *
 * Descriptions are prompt text. Keep them as guidance about what belongs under
 * the key, not restatements of the key itself.
 */
export const CORE_FACT_KEYS = {
  "identity.age":          "Age or rough age range, if the user has offered it.",
  "identity.background":   "Where they come from — upbringing, education, field of study.",
  "identity.household":    "Who they live with: family, partner, alone, flatmates.",

  "location.home":         "Where they are from or consider home. Usually stable.",
  "location.current":      "Where they are living now, if different from home. Often temporary.",

  "work.role":             "What they do — the discipline or craft, not the employer.",
  "work.status":           "Employment state: studying, interning, job hunting, employed, running a business.",
  "work.employer":         "Current employer or business, if any.",
  "work.hours":            "Working hours and days, in their own local time.",

  "money.currency":        "Currency they think in day to day.",
  "money.habits":          "How they relate to spending and to tracking it.",
  "money.goals":           "What they are saving for, or trying to change about their spending.",

  "health.constraints":    "Dietary restrictions, allergies, or conditions that should shape advice.",
  "health.routine":        "Exercise and sleep patterns.",

  "routine.daily":         "Shape of a typical day: meals, commute, focus blocks.",

  "social.relationships":  "People who come up often, and how they matter to the user.",

  "style.tone":            "How they want to be talked to: length, directness, formality.",
  "style.language":        "Languages they mix into conversation.",
};
