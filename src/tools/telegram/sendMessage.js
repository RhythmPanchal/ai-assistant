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

export async function sendMessage(chatId, text) {
  if (!chatId) {
    throw new Error(`[sendMessage] missing chat id : ${chatId}`);
  }

  const htmlText = markdownToTelegramHTML(text);

  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: htmlText,
      parse_mode: "HTML"
    })
  });

  const data = await response.json();

  // If HTML parsing fails, fallback to plain text (no formatting)
  if (!data.ok && data.description?.includes("can't parse entities")) {
    console.warn("[sendMessage] HTML parse failed, falling back to plain text");
    const fallback = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text  // send raw, unformatted
      })
    });
    return await fallback.json();
  }

  return data;
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
 * Sends a "✨ Thinking..." placeholder and animates it with a text spinner
 * while also keeping the Telegram "typing" chat action alive.
 *
 * Returns { messageId, stop() }.
 *
 * @param {number|string} chatId
 * @returns {Promise<{ messageId: number|null, stop: () => void }>}
 */
export async function createThinkingAnimation(chatId) {
  const frames = [
    "⏳ Processing",
    "⌛ Processing.",
    "⏳ Processing..",
    "⌛ Processing...",
  ];

  let stopped = false;

  // 1. Send the initial placeholder
  const msg = await sendMessage(chatId, frames[0]);
  const messageId = msg?.result?.message_id ?? null;

  let frameIndex = 1;

  // 2. Animate the placeholder every 1 s
  const animationId = messageId
    ? setInterval(() => {
        if (stopped) return; // guard: don't edit after stop
        const text = frames[frameIndex % frames.length];
        frameIndex++;
        editMessage(chatId, messageId, text).catch(() => {});
      }, 1000)
    : null;

  // 3. Keep Telegram "typing" badge alive every 4 s
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
      if (animationId) clearInterval(animationId);
      clearInterval(typingId);
    },
  };
}
