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
 * It is also why the request is stored once rather than once per step. Within
 * a turn the system instruction and the tool declarations are byte-identical
 * at every step and only the tail grows, so the system message is held once on
 * the turn and each step keeps only the messages it added. Writing the whole
 * array every step measured ~1 MB on an 18-call turn; this is ~20 KB.
 *
 * The replayed history is the part that genuinely could not be recovered: it
 * comes from up to 50 EARLIER chatHistory documents, and those move on. A
 * turn's own messages could have been rejoined from chatHistory, but they
 * arrive here anyway as part of step 1's delta, which costs little and means
 * one read answers what was sent.
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

    /**
     * How many of step 1's messages are replayed context from earlier turns
     * rather than this turn's own exchange. Nothing in the array itself says
     * so, and a reader who cannot tell them apart concludes the user said
     * something a previous day said.
     */
    historyCount: { bsonType: ["int", "long", "null"] },

    steps: {
      bsonType: "array",
      items: {
        bsonType: "object",
        properties: {
          step: { bsonType: ["int", "long"] },
          /**
           * What THIS request added to the one before it — the messages
           * appended since the last step, never the whole array. The array
           * grows by a couple of messages per step while its first twenty stay
           * identical, so storing it whole would write the same prompt once per
           * step. Step 1 carries everything but the system message, which is
           * held once above.
           */
          request: {
            bsonType: "array",
            items: {
              bsonType: "object",
              properties: {
                role: { bsonType: "string" },
                content: { bsonType: ["string", "object", "array", "null"] },
                toolName: { bsonType: ["string", "null"] },
                toolCalls: { bsonType: ["array", "null"] },
              },
            },
          },
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
