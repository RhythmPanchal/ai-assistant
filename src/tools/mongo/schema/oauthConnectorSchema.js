export const OAUTH_CONNECTOR = "oauthConnector";

const oauthConnectorSchema = {
  title: "oauthConnector",
  description: "Registered OAuth app credentials for third-party integrations.",
  bsonType: "object",
  properties: {
    appName: {
      bsonType: "string",
      description: "Unique identifier name for the OAuth app (e.g. google, notion)."
    },
    clientId: {
      bsonType: "string",
      description: "OAuth client ID issued by the provider."
    },
    clientSecret: {
      bsonType: "string",
      description: "OAuth client secret issued by the provider."
    },
    createdAt: { bsonType: "long", description: "Epoch ms timestamp." },
    updatedAt: { bsonType: "long", description: "Epoch ms timestamp." }
  },
  required: ["appName", "clientId", "clientSecret", "createdAt", "updatedAt"]
};

export default oauthConnectorSchema;
