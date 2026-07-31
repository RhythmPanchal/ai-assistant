import { BaseOAuthProvider } from "../oauth/oauthProvider.js";

export class NotionOauthProvider extends BaseOAuthProvider {
  authorizationURI = "https://api.notion.com/v1/oauth/authorize";
  tokenURI = "https://api.notion.com/v1/oauth/token";
  // Notion scopes are defined at integration creation time, not in the OAuth URL.
  scopes = [];

  // Notion requires owner=user for user-level access and does not use scope param.
  generateAuthorizationURL(state, redirectUri) {
    if (!this.authorizationURI) throw new Error("authorizationURI is not defined.");
    if (!state || !redirectUri) throw new Error("state and redirectUri are required.");

    const url = new URL(this.authorizationURI);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("state", state);
    return url.toString();
  }

  // Notion token exchange: POST with JSON body + HTTP Basic Auth header.
  // curl: curl -X POST https://api.notion.com/v1/oauth/token \
  //   -H "Authorization: Basic base64(client_id:client_secret)" \
  //   -H "Content-Type: application/json" \
  //   -d '{"grant_type":"authorization_code","code":"<code>","redirect_uri":"<redirect_uri>"}'
  buildTokenRequest(code, redirectUri) {
    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    return {
      url: this.tokenURI,
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    };
  }

  // Notion access tokens are permanent and do not expire — there is no refresh endpoint.
  buildRefreshRequest(_refreshToken) {
    throw new Error("Notion OAuth tokens do not expire and cannot be refreshed.");
  }

  async onConnectionEstablished(_userId) {}
}
