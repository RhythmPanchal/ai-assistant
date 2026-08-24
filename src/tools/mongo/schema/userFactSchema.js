export const USER_FACT = "userFact";

// Bare schema + default export, matching every other file here. createCollection
// reads module.default and applies the validator/$jsonSchema wrapper itself.
const userFactSchema = {
  title: "userFact",
  description:
    "Atomic narrative facts about a user, rendered into the system instruction every turn. One row per key — never append a second row for the same key.",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: "int",
      description: "Internal user id (users.userId), not a channel id.",
    },
    key: {
      bsonType: "string",
      description:
        "Canonical slug from the factKey registry, e.g. 'work.status'. Lowercase dot-separated. This is what makes an update an update instead of a contradiction.",
      pattern: "^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$",
    },
    fact: {
      bsonType: "string",
      description:
        "One self-contained sentence, written to be read by the model mid-prompt. Not a fragment: 'In Pune since Jun 2026 for work.', not 'Pune'.",
    },
    category: {
      bsonType: "string",
      description: "Rendering group only — it does not constrain which keys may exist.",
      enum: ["identity", "location", "work", "money", "health", "routine", "social", "style", "other"],
    },
    stability: {
      bsonType: "string",
      description:
        "'temporary' facts are true now but expected to change — a current city, a job hunt. The prompt marks them so the model verifies before relying on them.",
      enum: ["stable", "temporary"],
    },
    confidence: {
      bsonType: "string",
      description:
        "'stated' came from the user's own words; 'inferred' was extracted from behaviour. On conflict, stated wins.",
      enum: ["stated", "inferred"],
    },
    previousValue: {
      bsonType: ["string", "null"],
      description:
        "The single superseded value. One level only — enough for 'last I knew you were interviewing', without unbounded history.",
    },
    previousAt: {
      bsonType: ["date", "null"],
      description: "When previousValue was replaced.",
    },
    sourceTurn: {
      bsonType: ["objectId", "null"],
      description:
        "chatHistory _id this was extracted from. The only way to audit an inferred fact the user disputes.",
    },
    expiresAt: {
      bsonType: ["date", "null"],
      description:
        "When a temporary fact should stop being asserted. 'Job hunting' must lapse; otherwise it is still in the prompt three years later.",
    },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
  required: ["userId", "key", "fact", "stability", "confidence", "createdAt", "updatedAt"],
};

export default userFactSchema;

/**
 * Serves:
 *  - the profile render — find({ userId }), once per agent turn
 *  - rememberFact / the nightly extraction pass — upsert on (userId, key)
 *  - the expiry sweep — find({ expiresAt: { $lte: now } }) across all users
 *
 * unique on (userId, key) is the load-bearing constraint, not an optimisation.
 * The whole design rests on a second write to 'work.status' REPLACING the first;
 * without the index two extraction passes can both miss and both insert, and the
 * prompt ends up asserting that the user is simultaneously job hunting and
 * employed. It also serves find({ userId }) as a leading prefix, so the per-turn
 * read needs no index of its own.
 *
 * expiresAt is a plain sparse index, deliberately NOT a TTL index. A lapsed fact
 * should be reviewed and usually rewritten ("job hunting" becomes "employed at
 * X"), not silently deleted by the server while nobody is looking.
 *
 * Deliberately absent from WHITELISTED_COLLECTIONS in fetchRecords.js. The agent
 * reads this by injection, never by query — letting it fetchRecord its way into
 * the fact store is how invented keys and cross-user reads start.
 */
export const USER_FACT_INDEXES = [
  { key: { userId: 1, key: 1 }, name: "userId_1_key_1", unique: true },
  { key: { expiresAt: 1 }, name: "expiresAt_1", sparse: true },
];
