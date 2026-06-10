/**
 * The OAuth redirect URI must be byte-for-byte identical in three places:
 *   1. the Authorized redirect URI registered in the Google Cloud console
 *   2. the redirect_uri param on the consent URL   (getAuthUrl)
 *   3. the redirect_uri param on the token exchange (exchangeCode)
 *
 * Deriving it from a single source here guarantees 2 and 3 never drift, and
 * keeps the path in lock-step with the Express routes mounted in index.js.
 *
 * Path is /auth/callback to match the redirect URI already registered in the
 * Google Cloud console. /auth/start is our own internal kickoff endpoint and
 * does NOT need to be registered with Google.
 */

export const OAUTH_CALLBACK_PATH = "/auth/callback";
export const OAUTH_START_PATH = "/auth/start";

/**
 * Resolve the full callback URL. Prefers an explicit OAUTH_REDIRECT_URI
 * override; otherwise builds `${PUBLIC_BASE_URL}/auth/callback`.
 */
export function getRedirectUri() {
  const explicit = process.env.OAUTH_REDIRECT_URI;
  if (explicit) return explicit.replace(/\/+$/, "");

  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new Error(
      "[getRedirectUri] set PUBLIC_BASE_URL " +
      "(e.g. https://ai-assistant-ddqt.onrender.com) or OAUTH_REDIRECT_URI."
    );
  }
  return `${base.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Resolve the full /auth/start URL the Telegram Connect button points at.
 */
export function getStartUrl(stateToken) {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new Error(
      "[getStartUrl] PUBLIC_BASE_URL is required " +
      "(the public HTTPS origin of the Express server)."
    );
  }
  const origin = base.replace(/\/+$/, "");
  return `${origin}${OAUTH_START_PATH}?token=${encodeURIComponent(stateToken)}`;
}
