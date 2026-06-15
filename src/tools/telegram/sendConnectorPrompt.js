/**
 * Build and send the "Connect / Do not ask" inline-keyboard prompt for a
 * connector, and register the callback handler that updates the connector
 * when the user clicks "Do not ask".
 *
 * The prompt is generic — it works for any provider in the OAuth registry.
 * appName is carried in both:
 *   - the OAuth state token (server-side, behind the Connect URL)
 *   - the callback_data of the "Do not ask" button (client-side, comes back
 *     to us as a callback_query)
 * so the dismiss handler knows which connector to DISABLE without needing
 * one handler per app.
 *
 * Callback data conventions (Telegram caps callback_data at 64 bytes):
 *   connect:<appName>           -> URL button, not a callback_query — the
 *                                  Telegram client opens the OAuth start
 *                                  URL in the user's browser. The userId
 *                                  travels via the one-time state token.
 *   dismiss:<appName>:<userId>  -> sent back to us as a callback_query when
 *                                  the user taps "Do not ask"; we DISABLE
 *                                  the connector and clear the keyboard.
 */

import {
  sendMessage,
  answerCallbackQuery,
  clearInlineKeyboard
} from "./sendMessage.js";
import { registerCallbackHandler } from "./callbackRouter.js";
import { disableConnector } from "../mongo/operation/connector.js";
import { createOAuthState } from "../oauth/oauthState.js";
import { getStartUrl } from "../oauth/redirectUri.js";

const DISMISS_PREFIX = "dismiss:";

/**
 * Send the inline-keyboard prompt to the user. Mints a fresh state token so
 * the Connect URL is single-use.
 *
 * @param {number} userId
 * @param {string} appName       registered key in the provider registry
 * @param {string} messageText   plain text shown above the buttons
 */
export async function sendConnectorPrompt(userId, appName, messageText) {
  if (!userId || !appName || !messageText) {
    throw new Error(
      `userId, appName and messageText are required — userId: ${userId}, appName: ${appName}, messageText: ${messageText}`
    );
  }
  const stateToken = await createOAuthState(userId, appName);
  const connectUrl = getStartUrl(stateToken);

  // We need both a `url` button and a `callback_data` button in the same
  // row, so call sendMessage directly with a hand-built reply_markup
  // instead of the sendInlineButtons helper (which only emits one kind).
  return sendMessage(userId, messageText, {
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "🔗 Connect", url: connectUrl },
          { text: "🚫 Do not ask", callback_data: `${DISMISS_PREFIX}${appName}:${userId}` }
        ]
      ]
    }
  });
}

/**
 * Routes any callback_query whose data starts with "dismiss:" to here.
 * We parse out appName + userId, DISABLE that connector, ack the click,
 * and tidy up the chat. Errors are swallowed past the connector update
 * because UI cleanup failing is not worth blocking the user on.
 */
async function handleDismissClick(callbackQuery) {
  const data = callbackQuery.data; // "dismiss:<appName>:<userId>"
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  const rest = data.slice(DISMISS_PREFIX.length); // "<appName>:<userId>"
  const sep = rest.indexOf(":");
  if (sep === -1) {
    console.warn(`[dismiss] malformed callback_data "${data}"`);
    await answerCallbackQuery(callbackQuery.id, "Couldn't process that.");
    return;
  }
  const appName = rest.slice(0, sep);
  const uid = Number.parseInt(rest.slice(sep + 1), 10);

  if (!appName || !uid || Number.isNaN(uid)) {
    console.warn(`[dismiss] could not parse appName/userId from "${data}"`);
    await answerCallbackQuery(callbackQuery.id, "Couldn't process that.");
    return;
  }

  try {
    await disableConnector(uid, appName);
  } catch (err) {
    console.error(`[dismiss:${appName}] disableConnector threw:`, err);
  }

  await answerCallbackQuery(callbackQuery.id, "Got it — won't ask again.");

  // Clear the keyboard so the user can't double-click and re-trigger.
  if (chatId && messageId) {
    await clearInlineKeyboard(chatId, messageId).catch(() => {});
  }

  if (chatId) {
    await sendMessage(
      chatId,
      `Okay, I won't ask about ${appName} again. You can connect it any time later.`
    ).catch(() => {});
  }
}

// Module-load registration: the Connect button is a URL (handled server-side
// by oauth/routes.js), but the "Do not ask" button comes back as a
// callback_query. Registering here at module import time means clicks on
// buttons issued before a restart still route, as long as something imports
// this module on boot (insertSchedule does, transitively).
registerCallbackHandler(DISMISS_PREFIX, handleDismissClick);
