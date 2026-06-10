export const CONNECTORS = "connectors";

/**
 * Per-user third-party integrations (Google Calendar, Notion, etc).
 *
 * One document per (userId, appName) pair. Lifecycle:
 *   PENDING  -> never asked, or asked but not yet answered
 *   ENABLED  -> user authorized; tokens present and usable
 *   DISABLED -> user explicitly declined ("do not ask"), or refresh failed
 *               irrecoverably. Code paths must skip this connector silently.
 *
 * appData is a free-form object for per-app metadata (e.g. gCalendar stores
 * { calendarId } here once we provision the dedicated calendar).
 */
const connectorsSchema = {
  title: "connectors",
  description: "Per-user third-party app integrations (OAuth tokens + app-specific state).",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: "int",
      description: "Telegram chat id of the owning user."
    },

    appName: {
      bsonType: "string",
      description: "Identifier of the integration, e.g. 'gCalendar', 'notion'."
    },

    appSupport: {
      bsonType: "string",
      enum: ["PENDING", "ENABLED", "DISABLED"],
      description: "Lifecycle state — see file-level docstring."
    },

    accessToken: {
      bsonType: ["string", "null"],
      description: "Short-lived OAuth access token. Refreshed on expiry."
    },

    refreshToken: {
      bsonType: ["string", "null"],
      description: "Long-lived OAuth refresh token. Used to mint new access tokens."
    },

    accessTokenExpiresAt: {
      bsonType: ["date", "null"],
      description: "When the current accessToken expires (UTC)."
    },

    scope: {
      bsonType: ["string", "null"],
      description: "Scope string returned by the provider during the last token exchange."
    },

    appData: {
      bsonType: ["object", "null"],
      description: "App-specific state. e.g. gCalendar -> { calendarId }."
    },

    connectedAt: {
      bsonType: ["date", "null"],
      description: "When the user first authorized this connector."
    },

    disabledAt: {
      bsonType: ["date", "null"],
      description: "When the connector was last moved to DISABLED."
    },

    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: ["date", "null"] }
  },
  required: ["userId", "appName", "appSupport"]
};

export default connectorsSchema;
