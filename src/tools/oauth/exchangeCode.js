/**
 * Exchange the authorization `code` returned by the provider's consent
 * screen for an access_token + (usually) refresh_token bundle.
 *
 * Called from the /auth/callback Express handler. The returned shape is
 * normalized so the caller can hand it straight to
 * `enableConnectorWithTokens` and so provider-specific onConnected hooks
 * can read raw fields (Notion's workspace_id, bot_id, etc.) from `.raw`.
 *
 * Provider-specific concerns handled here:
 *   - tokenUrl                          — registry
 *   - client_id/secret env var names    — registry
 *   - tokenAuthStyle ("body" | "basic") — most providers want client creds
 *                                         in the form body, Notion requires
 *                                         HTTP Basic auth.
 *   - requireRefreshToken               — provider says it must come back;
 *                                         we throw with a helpful message
 *                                         if it doesn't (usually a missing
 *                                         access_type=offline).
 */

import { getRedirectUri } from "./redirectUri.js";
import { getProvider } from "./providerRegistry.js";

export async function exchangeCodeForTokens(appName, code) {
  if (!code) throw new Error("[exchangeCodeForTokens] authorization code is required");

  const provider = getProvider(appName);
  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];

  if (!clientId || !clientSecret) {
    throw new Error(
      `[exchangeCodeForTokens] ${provider.clientIdEnv} and ${provider.clientSecretEnv} required for appName "${appName}"`
    );
  }

  const redirectUri = getRedirectUri();
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const bodyParams = {
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  };

  if (provider.tokenAuthStyle === "basic") {
    // Notion-style: client creds go in an HTTP Basic auth header.
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else {
    // Google-style: client creds go in the form body.
    bodyParams.client_id = clientId;
    bodyParams.client_secret = clientSecret;
  }

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(bodyParams).toString()
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    const desc = data.error_description || data.error || res.statusText;
    throw new Error(`[exchangeCodeForTokens] ${appName} rejected exchange: ${desc}`);
  }

  if (provider.requireRefreshToken && !data.refresh_token) {
    throw new Error(
      `[exchangeCodeForTokens] ${appName} did not return a refresh_token — ` +
      "ensure the auth URL requests offline access " +
      "(Google needs access_type=offline AND prompt=consent)."
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresInSeconds: data.expires_in || null,
    scope: data.scope || null,
    tokenType: data.token_type || null,
    // Surface the full response so provider hooks can read fields outside
    // the OAuth spec (e.g. Notion's bot_id / workspace_id / owner).
    raw: data
  };
}
