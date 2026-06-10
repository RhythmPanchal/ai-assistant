export const OAUTH_STATES = "oauthStates";

/**
 * One-time-use CSRF state tokens for OAuth flows.
 *
 * When we send a "Connect" button to the user, we mint a random token, store
 * it here with the owning userId + appName, and embed the token in Google's
 * `state` param. On the callback we verify the returned state matches a row
 * here (and delete it).
 *
 * A TTL index on expiresAt (created at boot — see oauthState.js) prevents the
 * collection from growing forever if a user never clicks the button.
 */
const oauthStatesSchema = {
  title: "oauthStates",
  description: "Ephemeral OAuth CSRF state tokens.",
  bsonType: "object",
  properties: {
    token: {
      bsonType: "string",
      description: "Opaque random token embedded in the OAuth `state` param."
    },
    userId: { bsonType: "int" },
    appName: { bsonType: "string" },
    expiresAt: { bsonType: "date" },
    createdAt: { bsonType: "date" }
  },
  required: ["token", "userId", "appName", "expiresAt"]
};

export default oauthStatesSchema;
