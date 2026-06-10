/**
 * Inline-button callback_query router.
 *
 * Features register a handler for a callback_data prefix; the poller forwards
 * every callback_query update to `routeCallbackQuery`, which dispatches to the
 * first matching handler. Prefix-based routing is deliberately simple — no
 * regex, no params parsing here. The handler receives the full callback_data
 * string and can split/parse it however it likes.
 *
 * Convention for callback_data:
 *   "<feature>:<action>:<extras...>"
 *   e.g. "gcal:connect:1136575387"
 *        "gcal:dismiss:1136575387"
 *
 * Telegram limits callback_data to 64 bytes, so keep payloads small —
 * userId is fine, anything bigger should live server-side keyed by a token.
 */

const handlers = new Map(); // prefix -> async fn(callbackQuery)

/**
 * Register a handler for a callback_data prefix. The prefix is matched against
 * the start of the callback_data string with simple startsWith.
 *
 * @param {string} prefix       e.g. "gcal:"
 * @param {(callbackQuery: object) => Promise<void>} handler
 */
export function registerCallbackHandler(prefix, handler) {
  if (!prefix || typeof handler !== "function") {
    throw new Error("[registerCallbackHandler] prefix and handler required");
  }
  handlers.set(prefix, handler);
}

/**
 * Look up and run the handler for a callback_query update.
 * No-op (with a warning) if no handler matches the prefix.
 */
export async function routeCallbackQuery(callbackQuery) {
  const data = callbackQuery?.data;
  if (!data) {
    console.warn("[routeCallbackQuery] callback_query without data — ignoring");
    return;
  }

  for (const [prefix, handler] of handlers.entries()) {
    if (data.startsWith(prefix)) {
      try {
        await handler(callbackQuery);
      } catch (err) {
        console.error(`[routeCallbackQuery] handler for "${prefix}" threw:`, err);
      }
      return;
    }
  }

  console.warn(`[routeCallbackQuery] no handler for callback_data="${data}"`);
}
