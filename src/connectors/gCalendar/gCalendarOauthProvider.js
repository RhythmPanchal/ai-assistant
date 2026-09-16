import { BaseOAuthProvider } from "../oauth/oauthProvider.js";
import { localDateOf } from "../../tools/mongo/dateUtils.js";
import { serialiseCalendarSync, syncScheduleDay } from "./syncScheduleDay.js";

export class GCalendarOauthProvider extends BaseOAuthProvider {
  authorizationURI = "https://accounts.google.com/o/oauth2/v2/auth";
  tokenURI = "https://oauth2.googleapis.com/token";
  scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
  ];

  // Google requires access_type=offline for refresh tokens and prompt=consent
  // to guarantee the refresh token is returned even if previously granted.
  generateAuthorizationURL(state, redirectUri) {
    const url = new URL(super.generateAuthorizationURL(state, redirectUri));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  // Google token exchange: POST with form-encoded body.
  buildTokenRequest(code, redirectUri) {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    return {
      url: this.tokenURI,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    };
  }

  // Straight to the day sync rather than syncScheduleToCalendar: the connection
  // was just made ACTIVE, and that module reaches Telegram, which reaches back
  // into the OAuth layer this provider belongs to.
  async onConnectionEstablished(userId) {
    await serialiseCalendarSync(userId, () => syncScheduleDay(userId, localDateOf(new Date())));
  }

  // Google token refresh: same endpoint, swap grant_type and pass refresh_token.
  buildRefreshRequest(refreshToken) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    return {
      url: this.tokenURI,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    };
  }
}
