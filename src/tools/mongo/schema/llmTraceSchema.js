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
 * The replayed history is likewise the part that genuinely could not be
 * recovered: it
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
     * The parts of the system message that VARY, kept apart rather than as the
     * assembled blob.
     *
     * The persona, hard rules and output contract are identical every turn for
     * every user and live in instruction.js, so storing them was 6 KB a turn
     * of a constant — and it buried the overlay, which is the part that
     * differs per flow and the first thing worth reading when a routine
     * behaves unlike itself. baseChars keeps the assembled length as a sanity
     * check that nothing was dropped.
     */
    prompt: {
      bsonType: ["object", "null"],
      properties: {
        // One entry per overlay, next to what produced it: a flow's own
        // procedure and live data, the weekly goal nudge, the night notes
        // upkeep. Joined into the prompt these are one undifferentiated block.
        overlays: {
          bsonType: "array",
          items: {
            bsonType: "object",
            properties: {
              kind: { bsonType: "string", description: "flow | nudge | notesUpkeep" },
              flowType: { bsonType: ["string", "null"] },
              text: { bsonType: ["string", "null"] },
            },
          },
        },
        profile: { bsonType: ["string", "null"], description: "WHO YOU ARE HELPING, as rendered." },
        recent: { bsonType: ["string", "null"], description: "RECENTLY, as rendered." },
        carriedFrom: { bsonType: ["string", "null"], description: "Day the replayed history came from, when not today's." },
        baseChars: { bsonType: ["int", "long", "null"] },
      },
    },

    // Skills loaded during the turn, which widen both the tools and the system
    // message. Read at the end, because a skill can be loaded at any step.
    skills: { bsonType: ["array", "null"], items: { bsonType: "string" } },

    /**
     * The tool declarations as the model received them — names, descriptions
     * and parameter schemas, the half of the request that decides what it can
     * do at all.
     *
     * One entry per CHANGE, not per step. They are ~24 KB for 23 tools and
     * byte-identical until a skill loads and widens the set, so a per-step copy
     * would write the same 24 KB once per step. `fromStep` says where each set
     * took effect; a step's declarations are the last entry at or before it.
     */
    toolSets: {
      bsonType: ["array", "null"],
      items: {
        bsonType: "object",
        properties: {
          fromStep: { bsonType: ["int", "long"] },
          names: { bsonType: "array", items: { bsonType: "string" } },
          declarations: { bsonType: ["array", "string", "null"] },
        },
      },
    },

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
          // Names, for reading a step at a glance. The full declarations for
          // this step are the last toolSets entry with fromStep <= step.
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
