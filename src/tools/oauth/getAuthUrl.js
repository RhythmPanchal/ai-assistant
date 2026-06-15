/**
 * Build the provider's OAuth 2.0 authorization URL the user opens in their
 * browser. Provider-specific bits (endpoint, scope, extra params, client-id
 * env var) come from the provider registry — this file knows only the
 * generic shape of the authorization-code flow.
 *
 * Flow:
 *   1. We send the user a Telegram button whose URL is our
 *      `/auth/start?token=<state>` endpoint.
 *   2. That endpoint resolves the state to (userId, appName) and 302-
 *      redirects here.
 *   3. The provider shows its consent screen, then redirects back to the
 *      registered `/auth/callback` URL with `code` + `state`.
 */

import { getRedirectUri } from "./redirectUri.js";
import { getProvider } from "./providerRegistry.js";

/**
 * @param {string} appName  registered key in the provider registry
 * @param {string} state    one-time state token from oauthState.createOAuthState
 * @returns {string} fully-qualified consent URL
 */
export function getAuthUrl(appName, state) {
  if (!state) throw new Error("[getAuthUrl] state token is required");

  const provider = getProvider(appName);

  const clientId = process.env[provider.clientIdEnv];
  if (!clientId) {
    throw new Error(
      `[getAuthUrl] env var ${provider.clientIdEnv} must be set for appName "${appName}"`
    );
  }

  const redirectUri = getRedirectUri();

  // Build the params in a deterministic order: providers like Google care
  // very little, but it makes debug logs readable.
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    ...(provider.scope ? { scope: provider.scope } : {}),
    ...(provider.extraAuthParams || {})
  });

  return `${provider.authUrl}?${params.toString()}`;
}
