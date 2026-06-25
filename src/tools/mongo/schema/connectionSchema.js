export const CONNECTION = "connection";

const connectionSchema = {
  title: "connection",
  description: "Per-user OAuth connection state and token storage.",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: ["int", "string"],
      description: "Identifier of the user initiating the OAuth flow."
    },
    appName: {
      bsonType: "string",
      description: "OAuth app name matching an oauthConnector document."
    },
    status: {
      bsonType: "string",
      description: "Lifecycle state of the connection.",
      enum: ["PENDING", "ACTIVE", "INACTIVE", "DISABLED"]
    },
    code: {
      bsonType: ["string", "null"],
      description: "Authorization code received from the provider."
    },
    stateToken: {
      bsonType: ["string", "null"],
      description: "CSRF state token generated at flow initiation."
    },
    access_token: {
      bsonType: ["string", "null"],
      description: "OAuth access token."
    },
    refresh_token: {
      bsonType: ["string", "null"],
      description: "OAuth refresh token."
    },
    expiresAt: {
      bsonType: ["long", "null"],
      description: "Epoch ms timestamp when the access token expires."
    },
    scope: {
      bsonType: ["string", "null"],
      description: "Space-separated scopes granted by the provider."
    },
    createdAt: { bsonType: "long", description: "Epoch ms timestamp." },
    updatedAt: { bsonType: "long", description: "Epoch ms timestamp." }
  },
  required: ["userId", "appName", "status", "createdAt", "updatedAt"]
};

export default connectionSchema;
