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
  constructor(userId) {
    this.conversationId = crypto.randomUUID();
    this.userId = userId;
    this.messages = [];
    this.createdAt = new Date();
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

  build() {
    return {
      conversationId: this.conversationId,
      userId: this.userId,
      messages: this.messages
    };
  }
}
