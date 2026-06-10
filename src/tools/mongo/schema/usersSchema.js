export const USERS = "users";

const usersSchema = {
  title: "users",
  description: "Registered users of Rasmalai. One document per user. userId is the Telegram chat id.",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: "int",
      description: "Telegram chat id — also the canonical userId used across collections."
    },

    userName: {
      bsonType: "string",
      description: "Display name for the user."
    },

    userContext: {
      bsonType: ["string", "null"],
      description: "Free-form notes / persona / preferences the LLM should keep in mind for this user."
    },

    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: ["date", "null"] }
  },
  required: ["userId", "userName"]
};

export default usersSchema;
