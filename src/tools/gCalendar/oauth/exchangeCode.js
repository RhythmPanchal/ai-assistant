/**
 * Exchange the authorization `code` returned by Google's consent screen for
 * an access_token + refresh_token bundle.
 *
 * Called from the /oauth/google/callback Express handler. The returned
 * shape is normalized so the caller can hand it straight to
 * `enableConnectorWithTokens`.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function exchangeCodeForTokens(code) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "[exchangeCodeForTokens] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI required"
    );
  }
  if (!code) {
    throw new Error("[exchangeCodeForTokens] authorization code is required");
  }

  // Google's /token endpoint expects application/x-www-form-urlencoded.
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    const desc = data.error_description || data.error || res.statusText;
    throw new Error(`[exchangeCodeForTokens] Google rejected exchange: ${desc}`);
  }

  // refresh_token may be absent if the user previously authorized this app
  // and we forgot to set prompt=consent — guard explicitly.
  if (!data.refresh_token) {
    throw new Error(
      "[exchangeCodeForTokens] Google did not return a refresh_token — " +
      "ensure the auth URL uses access_type=offline and prompt=consent."
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: data.expires_in,
    scope: data.scope,
    tokenType: data.token_type
  };
}
