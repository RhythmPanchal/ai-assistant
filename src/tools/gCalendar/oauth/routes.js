/**
 * Express handlers for the gCalendar OAuth flow.
 *
 *   GET /oauth/google/start?token=<state>
 *     - resolves the one-time state token to a (userId, appName)
 *     - 302-redirects to Google's consent screen
 *
 *   GET /oauth/google/callback?code=...&state=...
 *     - verifies state, exchanges code for tokens
 *     - flips the connector to ENABLED with tokens stored
 *     - sends a Telegram confirmation message back to the user
 *     - renders a tiny "you can close this tab" page
 *
 * Errors are rendered as plain text so the user sees what went wrong; we
 * also log them server-side. We deliberately do NOT leak token values into
 * logs.
 */

import { peekOAuthState, consumeOAuthState } from "./oauthState.js";
import { getAuthUrl } from "./getAuthUrl.js";
import { exchangeCodeForTokens } from "./exchangeCode.js";
import {
  getConnector,
  enableConnectorWithTokens
} from "../../mongo/operation/connector.js";
import { sendMessage } from "../../telegram/sendMessage.js";

const GCALENDAR_APP = "gCalendar";

export async function handleOAuthStart(req, res) {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("Missing state token.");

    // peek (don't delete) — the token has to survive until the callback
    // returns so we can verify state across both legs of the flow.
    const resolved = await peekOAuthState(token);
    if (!resolved) {
      return res
        .status(400)
        .send("This link has expired or was already used. Ask the bot to send a fresh Connect button.");
    }

    const authUrl = getAuthUrl(token);
    return res.redirect(302, authUrl);
  } catch (err) {
    console.error("[handleOAuthStart]", err);
    return res.status(500).send("Something went wrong starting the OAuth flow.");
  }
}

export async function handleOAuthCallback(req, res) {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res
        .status(400)
        .send(`Google returned an error: ${error}. You can close this tab and try again.`);
    }
    if (!code || !state) {
      return res.status(400).send("Missing code or state.");
    }

    const resolved = await consumeOAuthState(state);
    if (!resolved) {
      return res
        .status(400)
        .send("Invalid or expired state. Ask the bot to send a fresh Connect button.");
    }
    const { userId, appName } = resolved;
    if (appName !== GCALENDAR_APP) {
      // Same callback URL today serves only gCalendar; refuse anything else
      // so we don't silently mis-route a future integration.
      return res.status(400).send(`Unsupported appName "${appName}".`);
    }

    const tokens = await exchangeCodeForTokens(code);
    await enableConnectorWithTokens(userId, appName, tokens);

    // Best-effort confirmation back into the chat — non-fatal if it fails.
    try {
      await sendMessage(
        userId,
        "✅ Google Calendar connected. Your future schedules will sync here automatically."
      );
    } catch (err) {
      console.warn("[handleOAuthCallback] confirmation message failed:", err.message);
    }

    return res.send(
      `<html><body style="font-family: sans-serif; padding: 2rem;">
         <h2>✅ Connected</h2>
         <p>Google Calendar is now linked. You can close this tab and return to Telegram.</p>
       </body></html>`
    );
  } catch (err) {
    console.error("[handleOAuthCallback]", err);
    return res
      .status(500)
      .send("Something went wrong completing the OAuth flow. Check server logs.");
  }
}
