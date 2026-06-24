export class BaseOAuthProvider {
  // Subclasses must define these as static or instance properties.
  authorizationURI = null;
  tokenURI = null;
  scopes = [];

  constructor({ clientId, clientSecret }) {
    if (!clientId || !clientSecret) {
      throw new Error("clientId and clientSecret are required.");
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  // Returns the full authorization redirect URL for the provider.
  // Subclasses override to append provider-specific params.
  generateAuthorizationURL(state, redirectUri) {
    if (!this.authorizationURI) throw new Error("authorizationURI is not defined.");
    if (!state || !redirectUri) throw new Error("state and redirectUri are required.");

    const url = new URL(this.authorizationURI);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  // Returns a { url, method, headers, body } object describing the token
  // exchange request. Subclasses must override this — token request shape
  // (body vs query params, content-type, extra fields) varies per provider.
  buildTokenRequest(_code, _redirectUri) {
    throw new Error(`buildTokenRequest() must be implemented by ${this.constructor.name}.`);
  }

  // Returns a { url, method, headers, body } object for refreshing an access token.
  // Subclasses must override — refresh request shape varies per provider.
  buildRefreshRequest(_refreshToken) {
    throw new Error(`buildRefreshRequest() must be implemented by ${this.constructor.name}.`);
  }
}
