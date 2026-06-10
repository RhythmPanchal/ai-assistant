/**
 * Build the Google OAuth 2.0 authorization URL the user opens in their
 * browser. The flow:
 *
 *   1. We send the user a Telegram button whose URL is our
 *      `/auth/start?token=<state>` endpoint.
 *   2. That endpoint looks up the state, then 302-redirects here.
 *   3. Google shows the consent screen, then redirects back to
 *      the registered redirect URI (`/auth/callback`) with `code` + `state`.
 *
 * Critical query params:
 *   - access_type=offline   : required to receive a refresh_token at all.
 *   - prompt=consent        : forces the consent screen every time so Google
 *                             *always* returns a refresh_token. Without this,
 *                             on re-auth Google may skip consent and omit the
 *                             refresh_token, breaking long-lived access.
 *   - include_granted_scopes=true : carries forward any prior grants the user
 *                                   already gave to this client.
 *   - state=<token>         : CSRF guard, verified on callback.
 */

import { getRedirectUri } from "./redirectUri.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

// Scope is intentionally `calendar.app.created` rather than full
// `calendar.events`: we only ever touch a calendar we created ourselves
// (one dedicated "Rasmalai" calendar per user). Narrower scope = easier
// verification later.
export const GCALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";

export function getAuthUrl(state) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("[getAuthUrl] GOOGLE_CLIENT_ID must be set");
  }
  if (!state) {
    throw new Error("[getAuthUrl] state token is required");
  }
  const redirectUri = getRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GCALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}
