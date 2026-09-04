import crypto from "crypto";

export const CHAT_HISTORY = "chatHistory";

const chatHistorySchema = {
  title: "chatHistory",
  description: "Conversation history — one document per user query containing all messages",
  bsonType: "object",
  properties: {
    conversationId: {
      bsonType: "string",
      description: "Unique identifier for this conversation turn"
    },
    userId: {
      bsonType: "int",
      description: "Unique user identifier (Telegram / Discord / internal)"
    },
    messages: {
      bsonType: "array",
      description: "Ordered list of messages in this conversation turn",
      items: {
        bsonType: "object",
        properties: {
          role: {
            bsonType: "string",
            enum: ["user", "assistant", "tool"],
            description: "Who sent the message"
          },
          content: {
            bsonType: ["string", "null"],
            description: "Text content (user or final assistant reply)"
          },
          functionCalls: {
            bsonType: ["array", "null"],
            description: "Function calls made by assistant",
            items: {
              bsonType: "object",
              properties: {
                name: { bsonType: "string" },
                args: { bsonType: "object" }
              }
            }
          },
          toolName: {
            bsonType: ["string", "null"],
            description: "Name of the tool that produced this result"
          },
          result: {
            bsonType: ["object", "array", "string", "null"],
            description: "Result returned by the tool"
          },
          timestamp: {
            bsonType: "date",
            description: "Exact time this message was created"
          }
        }
      }
    },
    // Which entry point produced this turn: "telegram", "goodMorningJob",
    // "goodNightJob", "summarizeJob". Absent on every row written before this
    // field existed, so readers must treat missing as a normal conversation.
    //
    // It exists to keep the summarize pass out of its own input. That pass runs
    // through runAgent like any other turn and so persists a document like any
    // other turn — and without a way to tell it apart, tomorrow's summarizer
    // reads yesterday's summarization exchange as if the user had said it, and
    // the agent replays a conversation with itself.
    source: {
      bsonType: ["string", "null"],
      description: "Entry point that produced this turn. Null/absent means a normal user conversation."
    },

    /**
     * What this turn cost in LLM calls.
     *
     * Per-turn detail lives here because chatHistory is already exactly one
     * document per turn. llmUsage is a daily rollup with a unique index on
     * (userId, ptDate) and structurally cannot hold it — the two answer
     * different questions, and the rollup can be rebuilt from these rows.
     * Absent on documents written before this field existed.
     */
    llmConversationMetadata: {
      bsonType: ["object", "null"],
      description: "Tokens, cost, latency and models for this turn",
      properties: {
        task: { bsonType: "string" },
        source: { bsonType: ["string", "null"] },
        outcome: { bsonType: "string", enum: ["ok", "error"] },
        steps: { bsonType: ["int", "long"] },
        // Counts failed attempts too — a 429'd request still spent quota.
        calls: { bsonType: ["int", "long"] },

        // toolMs = durationMs - llmMs. Derived, so no per-tool timing needed.
        durationMs: { bsonType: ["int", "long"] },
        llmMs: { bsonType: ["int", "long"] },
        toolMs: { bsonType: ["int", "long"] },

        models: {
          bsonType: "array",
          description: "Distinct provider:model that served a step",
          items: { bsonType: "string" }
        },

        // reasoning is billed as output but never shown, so a model that starts
        // thinking harder is otherwise an untraceable cost rise.
        tokens: {
          bsonType: "object",
          properties: {
            input: { bsonType: ["int", "long"] },
            output: { bsonType: ["int", "long"] },
            reasoning: { bsonType: ["int", "long"] },
            cached: { bsonType: ["int", "long"] },
            total: { bsonType: ["int", "long"] }
          }
        },

        // billed is what was charged (0 on a free tier); list is what the same
        // turn would cost at published prices, which stays meaningful anyway.
        cost: {
          bsonType: "object",
          properties: {
            billedUsd: { bsonType: ["double", "int"] },
            listUsd: { bsonType: ["double", "int", "null"] },
            priced: { bsonType: "bool" }
          }
        },

        // One row per outbound request, so a fallback cascade stays readable.
        attempts: {
          bsonType: "array",
          items: {
            bsonType: "object",
            properties: {
              provider: { bsonType: "string" },
              model: { bsonType: "string" },
              ok: { bsonType: "bool" },
              latencyMs: { bsonType: ["int", "long"] },
              input: { bsonType: ["int", "long"] },
              output: { bsonType: ["int", "long"] },
              reasoning: { bsonType: ["int", "long"] },
              cached: { bsonType: ["int", "long"] },
              billedUsd: { bsonType: ["double", "int"] },
              listUsd: { bsonType: ["double", "int", "null"] },
              errorKind: { bsonType: ["string", "null"] }
            }
          }
        }
      }
    },
    createdAt: {
      bsonType: "date"
    }
  },

  required: ["conversationId", "userId", "messages"]
};
export default chatHistorySchema;

/**
 * Serves both reads in chatHistoryKnowledge, which run before every single
 * agent turn:
 *  - today's turns  — find({ userId, createdAt: {$gte,$lte} })
 *                     .sort({ createdAt: -1 }).limit(50)
 *  - the fallback   — find({ userId }).sort({ createdAt: -1 }).limit(5)
 *
 * Descending on createdAt matches the sort, so the limit stops after reading
 * exactly as many index entries as it needs. This is the collection that grows
 * without bound, so it is the one where a missing index degrades worst over
 * time — every turn would scan the whole history to find today's.
 */
export const CHAT_HISTORY_INDEXES = [
  { key: { userId: 1, createdAt: -1 }, name: "userId_1_createdAt_-1" },
];


/**
 * Builder that accumulates messages for a single conversation turn
 * and produces the final document to insert into MongoDB.
 */
export class ConversationBuilder {
  constructor(userId, source = null) {
    this.conversationId = crypto.randomUUID();
    this.userId = userId;
    this.source = source;
    this.messages = [];
    this.createdAt = new Date();
    this.llmConversationMetadata = null;
  }

  addUserMessage(content) {
    this.messages.push({
      role: "user",
      content,
      timestamp: new Date(),
    });
    return this;
  }

  addAssistantMessage(content) {
    this.messages.push({
      role: "assistant",
      content,
      timestamp: new Date(),
    });
    return this;
  }

  addAssistantFunctionCalls(functionCalls) {
    this.messages.push({
      role: "assistant",
      functionCalls: functionCalls.map(fc => ({
        name: fc.name,
        args: fc.args,
      })),
      timestamp: new Date(),
    });
    return this;
  }

  addToolResult(toolName, result) {
    this.messages.push({
      role: "tool",
      toolName,
      result,
      timestamp: new Date(),
    });
    return this;
  }

  /** Attach the turn's LLM cost. Called once, after the loop finishes. */
  setMetrics(metrics) {
    this.llmConversationMetadata = metrics;
    return this;
  }

  build() {
    return {
      conversationId: this.conversationId,
      userId: this.userId,
      source: this.source,
      messages: this.messages,
      // Omitted rather than null when absent, so a turn that died before the
      // meter closed carries no field at all.
      ...(this.llmConversationMetadata
        ? { llmConversationMetadata: this.llmConversationMetadata }
        : {})
    };
  }
}
