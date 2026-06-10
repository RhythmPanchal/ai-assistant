const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/**
 * Converts basic Markdown (that LLMs commonly produce) into Telegram-safe HTML.
 * Handles: bold, italic, code blocks, inline code, and strips unsupported syntax.
 */
function markdownToTelegramHTML(text) {
  if (!text) return "";

  let result = text;

  // Code blocks: ```lang\ncode\n``` → <pre><code>code</code></pre>
  result = result.replace(/```[\w]*\n?([\s\S]*?)```/g, "<pre><code>$1</code></pre>");

  // Inline code: `text` → <code>text</code>
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold: **text** or *text* → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<b>$1</b>");

  // Italic: _text_ → <i>text</i>  (but not inside words like snake_case)
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Strip leftover MarkdownV2 escape backslashes: \. \! \- etc.
  result = result.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");

  return result;
}

/**
 * Send a Telegram message.
 *
 * @param {number|string} chatId
 * @param {string} text
 * @param {object} [options]
 * @param {object} [options.replyMarkup]  Telegram reply_markup object
 *   (e.g. { inline_keyboard: [[ { text, callback_data | url } ]] }). Forwarded
 *   verbatim to the Bot API; we don't validate shape.
 */
export async function sendMessage(chatId, text, options = {}) {
  if (!chatId) {
    throw new Error(`[sendMessage] missing chat id : ${chatId}`);
  }

  const htmlText = markdownToTelegramHTML(text);

  const body = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: "HTML"
  };
  if (options.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }

  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  // If HTML parsing fails, fallback to plain text (no formatting). Keep
  // reply_markup so the buttons still render in the fallback path.
  if (!data.ok && data.description?.includes("can't parse entities")) {
    console.warn("[sendMessage] HTML parse failed, falling back to plain text");
    const fallbackBody = { chat_id: chatId, text };
    if (options.replyMarkup) fallbackBody.reply_markup = options.replyMarkup;
    const fallback = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fallbackBody)
    });
    return await fallback.json();
  }

  return data;
}

/**
 * Higher-level helper: send a message with a row of inline buttons.
 * Buttons are objects of the form { text, callbackData } (button click sends
 * the callback_data string back to us via callback_query) or { text, url }
 * (opens the URL in the user's browser — used for OAuth start links).
 *
 * @param {number|string} chatId
 * @param {string} text
 * @param {Array<{text: string, callbackData?: string, url?: string}>} buttons
 */
export async function sendInlineButtons(chatId, text, buttons) {
  const row = buttons.map(b => {
    if (b.url) return { text: b.text, url: b.url };
    return { text: b.text, callback_data: b.callbackData };
  });
  return sendMessage(chatId, text, {
    replyMarkup: { inline_keyboard: [row] }
  });
}

/**
 * Acknowledge a callback_query so Telegram stops showing the loading
 * spinner on the button. Optionally show a small toast to the user.
 */
export async function answerCallbackQuery(callbackQueryId, text = "") {
  return fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    })
  });
}

/**
 * Strip the inline keyboard from a message after the user clicks one of its
 * buttons — prevents a second click from re-triggering the action.
 */
export async function clearInlineKeyboard(chatId, messageId) {
  return fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    })
  });
}

/**
 * Edits an existing Telegram message in-place.
 *
 * @param {number|string} chatId
 * @param {number}        messageId  - message_id returned by sendMessage
 * @param {string}        text       - new text content
 */
export async function editMessage(chatId, messageId, text) {
  const htmlText = markdownToTelegramHTML(text);

  const response = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: htmlText,
      parse_mode: "HTML",
    }),
  });

  const data = await response.json();

  // If HTML parsing fails, fallback to plain text
  if (!data.ok && data.description?.includes("can't parse entities")) {
    console.warn("[editMessage] HTML parse failed, falling back to plain text");
    const fallback = await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
      }),
    });
    return await fallback.json();
  }

  return data;
}

/**
 * Sends a single "Processing..." placeholder message and keeps the
 * Telegram "typing" chat action alive while the agent works.
 *
 * The text-edit animation was removed: Telegram rate-limits messages
 * at ~1/sec/chat, so the per-second editMessage calls could queue
 * ahead of the real reply and delay the final response. The free
 * sendChatAction("typing") indicator gives the same UX signal
 * without consuming the chat's message-rate budget.
 *
 * Returns { messageId, stop() }.
 *
 * @param {number|string} chatId
 * @returns {Promise<{ messageId: number|null, stop: () => void }>}
 */
export async function createThinkingAnimation(chatId) {
  let stopped = false;

  // 1. Send the initial placeholder so we have a message_id to edit later.
  const msg = await sendMessage(chatId, "⏳ Processing...");
  const messageId = msg?.result?.message_id ?? null;

  // 2. Keep Telegram "typing" badge alive every 4 s (it auto-clears after ~5 s).
  const typingId = setInterval(() => {
    if (stopped) return;
    fetch(`${TELEGRAM_API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch(() => {});
  }, 4000);

  return {
    messageId,
    stop: () => {
      stopped = true; // flag first, so any in-flight callback is a no-op
      clearInterval(typingId);
    },
  };
}
