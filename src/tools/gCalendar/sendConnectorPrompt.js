/**
 * Build and send the "Connect Google Calendar / Do not ask" inline-keyboard
 * prompt, and register the callback handler that updates the connector when
 * the user clicks one of the buttons.
 *
 * Callback data conventions (Telegram caps callback_data at 64 bytes):
 *   gcal:connect       -> opened as a URL in user's browser; uses Telegram's
 *                         `url` button type. NOT a callback_query because we
 *                         want a browser redirect, not a server ping. URL
 *                         carries the userId via the state token.
 *   gcal:dismiss:<uid> -> sent back to us as a callback_query when the user
 *                         taps "Do not ask"; we DISABLE the connector and
 *                         clear the keyboard.
 */

import {
  sendMessage,
  answerCallbackQuery,
  clearInlineKeyboard
} from "../telegram/sendMessage.js";
import { registerCallbackHandler } from "../telegram/callbackRouter.js";
import { disableConnector } from "../mongo/operation/connector.js";
import { createOAuthState } from "./oauth/oauthState.js";
import { getStartUrl } from "./oauth/redirectUri.js";

const GCALENDAR_APP = "gCalendar";
const DISMISS_PREFIX = "gcal:dismiss:";

/**
 * Send the inline-keyboard prompt to the user. Mints a fresh state token so
 * the Connect URL is single-use. The dismiss callback handler is registered
 * once at module load (see the side-effect call at the bottom of this file)
 * so a click on a button issued before a restart still routes correctly.
 */
export async function sendConnectorPrompt(userId, appName = GCALENDAR_APP) {
  const stateToken = await createOAuthState(userId, appName);
  const connectUrl = getStartUrl(stateToken);

  const text =
    "📅 *Sync your schedule to Google Calendar?*\n" +
    "If you connect, every schedule I create will appear in your calendar with notifications at each slot's start time.";

  // We need both a `url` button and a `callback_data` button in the same
  // row, so call sendMessage directly with a hand-built reply_markup
  // instead of the sendInlineButtons helper (which only emits one kind).
  return sendMessage(userId, text, {
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "🔗 Connect", url: connectUrl },
          { text: "🚫 Do not ask", callback_data: `${DISMISS_PREFIX}${userId}` }
        ]
      ]
    }
  });
}

async function handleDismissClick(callbackQuery) {
  const data = callbackQuery.data; // "gcal:dismiss:<uid>"
  const uid = Number.parseInt(data.slice(DISMISS_PREFIX.length), 10);
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (!uid || Number.isNaN(uid)) {
    console.warn(`[gcal:dismiss] could not parse userId from "${data}"`);
    await answerCallbackQuery(callbackQuery.id, "Couldn't process that.");
    return;
  }

  try {
    await disableConnector(uid, GCALENDAR_APP);
  } catch (err) {
    console.error("[gcal:dismiss] disableConnector threw:", err);
  }

  await answerCallbackQuery(callbackQuery.id, "Got it — won't ask again.");

  // Clear the keyboard so the user can't double-click and re-trigger.
  if (chatId && messageId) {
    await clearInlineKeyboard(chatId, messageId).catch(() => {});
  }

  // Confirmation message so the user sees the action took effect.
  if (chatId) {
    await sendMessage(
      chatId,
      "Okay, I won't sync to Google Calendar. You can ask me to connect it any time later."
    ).catch(() => {});
  }
}

// Module-load registration: the Connect button is a URL (handled server-side
// by oauth/routes.js), but the "Do not ask" button comes back as a
// callback_query. Registering here at module import time means clicks on
// buttons issued before a restart still route, as long as something imports
// this module on boot (insertSchedule does, transitively).
registerCallbackHandler(DISMISS_PREFIX, handleDismissClick);
