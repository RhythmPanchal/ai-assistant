/**
 * Generic Express handlers for the OAuth flow. Dispatch is by `appName`
 * carried in the one-time state token, not by URL path — so the same two
 * routes serve every connector (gCalendar today, notion / microsoft later).
 *
 *   GET /auth/start?token=<state>
 *     - resolves the one-time state token to a (userId, appName)
 *     - 302-redirects to the provider's consent screen
 *
 *   GET /auth/callback?code=...&state=...
 *     - verifies state, exchanges code for tokens
 *     - flips the connector to ENABLED with tokens stored
 *     - runs the provider's onConnected hook (confirmation message,
 *       provisioning, etc.)
 *     - renders a tiny "you can close this tab" page
 *
 * Errors are rendered as plain text so the user sees what went wrong; we
 * also log them server-side. We deliberately do NOT leak token values into
 * logs.
 */

import { peekOAuthState, consumeOAuthState } from "./oauthState.js";
import { getAuthUrl } from "./getAuthUrl.js";
import { exchangeCodeForTokens } from "./exchangeCode.js";
import { getProvider } from "./providerRegistry.js";
import { enableConnectorWithTokens } from "../mongo/operation/connector.js";

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

    const { appName } = resolved;
    const authUrl = getAuthUrl(appName, token);
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
        .send(`Provider returned an error: ${escapeHtml(error)}. You can close this tab and try again.`);
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

    // Will throw if the appName isn't registered — defensive guard against
    // mis-routing a future integration the OAuth core doesn't know about.
    const provider = getProvider(appName);

    const tokens = await exchangeCodeForTokens(appName, code);
    await enableConnectorWithTokens(userId, appName, tokens);

    // Provider-specific extras: confirmation message, resource provisioning,
    // etc. Treated as best-effort — if the hook fails the connection itself
    // is still good (tokens are already persisted), we just log and move on.
    if (provider.onConnected) {
      try {
        await provider.onConnected(userId, tokens);
      } catch (err) {
        console.warn(`[handleOAuthCallback] ${appName}.onConnected hook failed:`, err.message);
      }
    }

    return res.send(
      `<html><body style="font-family: sans-serif; padding: 2rem;">
         <h2>✅ Connected</h2>
         <p>${escapeHtml(appName)} is now linked. You can close this tab and return to Telegram.</p>
       </body></html>`
    );
  } catch (err) {
    console.error("[handleOAuthCallback]", err);
    return res
      .status(500)
      .send("Something went wrong completing the OAuth flow. Check server logs.");
  }
}

// Tiny HTML escape — only used on values we render straight from query/state
// (provider error strings, appName) so injection is impossible even if a
// future provider name contained user-influenced characters.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[c]));
}
