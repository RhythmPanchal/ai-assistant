export const USER_IDENTITY = "userIdentity";

// Bare schema + default export, matching every other file here. createCollection
// reads module.default and applies the validator/$jsonSchema wrapper itself.
const userIdentitySchema = {
  title: "userIdentity",
  description:
    "Maps a channel's own id for a person onto our internal users.userId. One row per (channel, externalId).",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: "int",
      description: "Internal id from users.userId. Many identities may point at one user.",
    },
    channel: {
      bsonType: "string",
      description: "Which system externalId belongs to.",
      enum: ["telegram", "app"],
    },
    externalId: {
      bsonType: "string",
      description:
        "The channel's id for this person — for Telegram, message.from.id. Stored as a STRING: Discord snowflakes exceed int64 and Telegram is moving to 64-bit ids, so the only shape that holds every channel is text.",
    },
    address: {
      bsonType: ["string", "null"],
      description:
        "Where to SEND on this channel — for Telegram, message.chat.id. Usually equal to externalId in a private chat, and deliberately separate because in a group it is the group's id. Never use userId as an address.",
    },
    displayName: {
      bsonType: ["string", "null"],
      description: "Channel-side name, for logs. Not the user's preferred name — that is users.name.",
    },
    isPrimary: {
      bsonType: "bool",
      description:
        "Which identity outbound messages use when a user has several. Exactly one per user should be true.",
    },
    linkedAt: { bsonType: "date", description: "When this identity was attached to the user." },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" },
  },
  required: ["userId", "channel", "externalId", "createdAt", "updatedAt"],
};

export default userIdentitySchema;

/**
 * Serves:
 *  - resolveUserByChannel — findOne({ channel, externalId }), once per inbound
 *    message, so it is on the hottest path in the system
 *  - resolveAddress       — findOne({ userId, channel }), once per outbound
 *    message from a job, reminder, or connector prompt
 *
 * unique on (channel, externalId): it is the identity of the row, and it is what
 * makes concurrent first-contact safe. Two messages from a new user racing each
 * other both try to create — the loser gets a duplicate-key error and re-reads,
 * instead of minting a second userId for the same person.
 *
 * NOT unique on (userId, channel). A user legitimately has several Telegram
 * addresses — a private chat and any group the bot shares with them — and
 * isPrimary picks the one for outbound.
 */
export const USER_IDENTITY_INDEXES = [
  { key: { channel: 1, externalId: 1 }, name: "channel_1_externalId_1", unique: true },
  { key: { userId: 1, channel: 1 }, name: "userId_1_channel_1" },
];
