import { getDB } from "../../tools/mongo/mongoClient.js";
import { GCalendarOauthProvider } from "../gCalendar/gCalendarOauthProvider.js";

const PROVIDER_MAP = {
  gCalendar: GCalendarOauthProvider,
};

// Fetches credentials from oauthConnector collection and returns an
// instantiated provider for the given appName.
export async function resolveProvider(appName) {
  const db = await getDB();
  const connector = await db.collection("oauthConnector").findOne({ appName });
  if (!connector) {
    throw new Error(`No oauthConnector registered for appName: ${appName}`);
  }

  const ProviderClass = PROVIDER_MAP[appName];
  if (!ProviderClass) {
    throw new Error(`No provider implementation found for appName: ${appName}`);
  }

  return new ProviderClass({
    clientId: connector.clientId,
    clientSecret: connector.clientSecret,
  });
}

export async function startOauth(state, res) {
  if (!state) {
    return res.status(400).json({ error: "Missing state parameter." });
  }

  try {
    const db = await getDB();
    const connection = await db.collection("connection").findOne({ stateToken: state });
    if (!connection) {
      return res.status(400).json({ error: "Invalid or expired state token." });
    }

    const appOauthProvider = await resolveProvider(connection.appName);

    const redirectUri = `${process.env.OAUTH_CALLBACK}`;
    const authorizationURL = appOauthProvider.generateAuthorizationURL(state, redirectUri);

    return res.redirect(authorizationURL);
  } catch (err) {
    console.error("[startOauth] Failed to initiate OAuth flow:", err);
    return res.status(500).json({ error: "Failed to initiate OAuth flow." });
  }
}
