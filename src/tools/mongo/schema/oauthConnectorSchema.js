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

/**
 * Serves resolveProvider — findOne({ appName }), on every OAuth start and
 * callback. unique: appName is the key the PROVIDER_MAP is looked up by, and
 * two rows would mean the clientId used depends on document order.
 */
export const OAUTH_CONNECTOR_INDEXES = [
  { key: { appName: 1 }, name: "appName_1", unique: true },
];
