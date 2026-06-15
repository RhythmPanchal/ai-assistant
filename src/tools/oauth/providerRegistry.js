/**
 * Map of `appName` → provider config. This is the *only* place that knows
 * which third-party providers Rasmalai integrates with for OAuth.
 *
 * Provider config interface (kept loose on purpose — fields are read by
 * getAuthUrl / exchangeCode / refresh as needed):
 *
 *   appName            : string                 — also the connectors.appName key
 *   authUrl            : string                 — provider's authorization endpoint
 *   tokenUrl           : string                 — provider's token endpoint
 *   clientIdEnv        : string                 — env var name for the client id
 *   clientSecretEnv    : string                 — env var name for the client secret
 *   scope              : string | null          — provider scope string (space-separated)
 *   extraAuthParams    : object | null          — extra params on the consent URL
 *                                                 (e.g. Google needs access_type=offline,
 *                                                 prompt=consent)
 *   tokenAuthStyle     : "body" | "basic"       — how client_id/secret are sent to /token
 *                                                 (Notion uses "basic", most use "body")
 *   hasRefreshToken    : boolean                — false for providers like Notion that
 *                                                 issue tokens that never expire
 *   requireRefreshToken: boolean                — throw on first exchange if the provider
 *                                                 didn't return one. Should be true for
 *                                                 providers with hasRefreshToken=true.
 *   onConnected        : async (userId, tokens) => void
 *                                               — provider-specific hook that runs after
 *                                                 tokens are persisted (send confirmation
 *                                                 message, provision dedicated resources,
 *                                                 etc.). Errors are caught and logged.
 *
 * Adding a new provider = create `src/tools/<app>/provider.js` exporting a
 * config object that matches this shape, then add one line below.
 */

import { gCalendarProvider } from "../gCalendar/provider.js";

const REGISTRY = Object.freeze({
  [gCalendarProvider.appName]: gCalendarProvider
});

/**
 * Look up a provider config by appName. Throws if unknown so callers can't
 * silently mis-route a callback.
 *
 * @param {string} appName
 * @returns {object}
 */
export function getProvider(appName) {
  const p = REGISTRY[appName];
  if (!p) {
    throw new Error(
      `[providerRegistry] unknown appName "${appName}". ` +
      `Known: ${Object.keys(REGISTRY).join(", ") || "<none>"}.`
    );
  }
  return p;
}

/**
 * Return the list of registered appNames. Useful for diagnostics / tests.
 */
export function listProviders() {
  return Object.keys(REGISTRY);
}
