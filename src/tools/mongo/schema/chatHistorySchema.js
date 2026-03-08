export const CHAT_HISTORY = "chatHistory"; 

const chatHistorySchema = {
  title: "chatHistory",
  description: "Conversation history between user and assistant",
  bsonType: "object",
  properties: {
    _id: { bsonType: "objectId" },
    userId: {
      bsonType: "int",
      description: "Unique user identifier (Telegram / Discord / internal)"
    },
    role: {
      bsonType: "string",
      enum: ["user", "assistant", "system"],
      description: "Who sent the message"
    },
    text: {
      bsonType: "string",
      description: "Message content"
    },
    timestamp: {
      bsonType: "date",
      description: "Exact time message was sent"
    },
    createdAt: {
      bsonType: "date"
    }
  },

  required: ["userId", "role", "text", "timestamp", "createdAt"]
};
export default chatHistorySchema;


export function chatHistoryBuilder(userId, text, role = "user") {
    return {
        userId: userId,
        role: role,
        text: text,
        timestamp: new Date(),   // event time
        createdAt: new Date()    // insert time
    };
}



