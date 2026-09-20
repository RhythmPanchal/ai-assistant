export const LLM_TRACE = "llmTrace";

/**
 * What a turn actually sent to a model, and what came back.
 *
 * A SEPARATE collection, not more fields on chatHistory, for one reason that
 * decides the whole design: chatHistory is read before every single turn, up
 * to 50 documents of it. A turn's request is 70-250 KB against the 5 KB a
 * turn costs today, so putting it there would make every traced user's every
 * turn pay to read traces it does not use.
 *
 * It is also why nothing here is the request itself. Within one turn the
 * system instruction and the tool declarations are byte-identical at every
 * step — only the tail grows, and that tail is already in chatHistory as the
 * user message, the function calls and the tool results. So this stores the
 * parts that cannot be reconstructed, and a reader rebuilds the rest by
 * joining on conversationId. ~20 KB a turn rather than ~1 MB.
 *
 * Written only for users with preferences.llmTrace on, and pruned by TTL.
 */
const llmTraceSchema = {
  title: "llmTrace",
  description: "Per-turn record of what was sent to the model and what it returned. Debug only.",
  bsonType: "object",
  properties: {
    // The chatHistory turn this belongs to. Everything else about the turn —
    // the messages, the tool arguments and results — is read from there.
    conversationId: { bsonType: "string" },
    userId: { bsonType: ["int", "long"] },
    task: { bsonType: ["string", "null"] },
    source: { bsonType: ["string", "null"] },

    /**
     * The system message as built for THIS turn: persona, hard rules, the
     * profile block, RECENTLY, any flow overlay, and any skill appended
     * mid-turn. Rebuilt every turn and never stored anywhere else, which makes
     * it the one input that cannot be recovered after the fact — and the first
     * thing worth reading when a reply is wrong about the person.
     */
    systemInstruction: { bsonType: ["string", "null"] },

    steps: {
      bsonType: "array",
      items: {
        bsonType: "object",
        properties: {
          step: { bsonType: ["int", "long"] },
          // Names only. The schemas are in code and identical every turn, so
          // storing them would be 24 KB of the same bytes per step. What
          // changes, and is worth knowing, is WHICH tools the model could see
          // — a skill loaded mid-turn widens this.
          toolsOffered: { bsonType: "array", items: { bsonType: "string" } },
          // Every request this step made, failures first, in order. A step
          // with four entries means three models refused before one answered.
          attempts: {
            bsonType: "array",
            items: {
              bsonType: "object",
              properties: {
                provider: { bsonType: "string" },
                model: { bsonType: "string" },
                ok: { bsonType: "bool" },
                latencyMs: { bsonType: ["int", "long"] },
                errorKind: { bsonType: ["string", "null"] },
                errorMessage: { bsonType: ["string", "null"] },
                finishReason: { bsonType: ["string", "null"] },
                // The provider's own response object, clipped. Carries the
                // finish reason, safety verdicts and the text as it was before
                // this codebase normalised it — the difference between "the
                // model said something odd" and "we mangled it".
                rawResponse: { bsonType: ["object", "string", "null"] },
              },
            },
          },
        },
      },
    },

    createdAt: { bsonType: "date" },
  },

  required: ["conversationId", "userId", "createdAt"],
};

export default llmTraceSchema;

/** How long a trace is kept. Long enough to debug last week, not a second archive. */
export const LLM_TRACE_TTL_DAYS = 14;

/**
 * Reads are always by conversationId — the console fetches the trace for one
 * turn it is already showing.
 *
 * The TTL index is the whole storage policy. Without it this collection is the
 * one that grows without bound and is never read again: expireAfterSeconds on
 * createdAt lets Mongo delete them and means nothing has to remember to.
 */
export const LLM_TRACE_INDEXES = [
  { key: { conversationId: 1 }, name: "conversationId_1" },
  {
    key: { createdAt: 1 },
    name: "createdAt_ttl",
    expireAfterSeconds: LLM_TRACE_TTL_DAYS * 24 * 60 * 60,
  },
];
