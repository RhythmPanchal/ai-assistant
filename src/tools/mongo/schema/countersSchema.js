export const COUNTERS = "counters";

// The sequence userIdentity/users allocate from. Named rather than magic so a
// second sequence (invoice numbers, say) does not need a second collection.
export const USER_ID_SEQUENCE = "userId";

// Bare schema + default export, matching every other file here. createCollection
// reads module.default and applies the validator/$jsonSchema wrapper itself.
const countersSchema = {
  title: "counters",
  description: "Monotonic sequence generators. One document per sequence, keyed by _id.",
  bsonType: "object",
  properties: {
    _id: { bsonType: "string", description: "Sequence name, e.g. 'userId'." },
    seq: {
      bsonType: ["int", "long"],
      description: "Last value handed out. The next allocation is seq + 1.",
    },
  },
  required: ["_id", "seq"],
};

export default countersSchema;

/**
 * No indexes, deliberately. Every read and write is by _id, which Mongo indexes
 * and enforces as unique by definition — an entry here would be a duplicate of
 * that index under a different name.
 *
 * Allocation is a single findOneAndUpdate with $inc and upsert, which is atomic
 * per document. That is the whole reason this collection exists instead of
 * `count() + 1`: two users signing up in the same tick cannot receive the same
 * id, with no lock and no transaction.
 */
export const COUNTERS_INDEXES = [];
