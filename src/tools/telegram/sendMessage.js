import { renderForTelegram, markdownToTelegramHTML } from "./renderMarkdown.js";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Telegram accepts roughly one message per second per chat. A single reply is
// one message and never touches this; a split reply would burst and earn a 429,
// so chunks after the first are spaced. Well under the limit, invisible to read.
const CHUNK_GAP_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTML back to readable prose, for the fallback path.
 *
 * Sending the ORIGINAL Markdown here would be worse than it sounds: the user
 * would see the raw "*bold*" and "`code`" syntax. Stripping our own tags leaves
 * the sentence the agent actually wrote.
 */
function htmlToPlain(html) {
    return String(html ?? "")
        .replace(/<\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler)\b[^>]*>/gi, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&"); // last, or an escaped "&amp;lt;" would decode twice
}

/**
 * One HTML payload to one chat.
 *
 * The fallback is deliberately broad. Since the renderer escapes properly,
 * "can't parse entities" should no longer be reachable — but a message that
 * fails to send is invisible to the user AND to the logs, which is how a stuck
 * "Processing..." placeholder used to happen. Anything that is not a rate limit
 * gets one plain-text retry rather than being dropped.
 */
async function postMessage(chatId, html, options = {}) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: html,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...options,
        }),
    });

    const data = await response.json();
    if (data.ok) return data;

    console.warn(`[sendMessage] Telegram refused (${data.error_code}): ${data.description}`);

    // 429 means slow down, not "reformat". Retrying as plain text would send the
    // same message twice the moment the limit clears.
    if (data.error_code === 429) return data;

    const fallback = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: htmlToPlain(html),
            link_preview_options: { is_disabled: true },
            ...options,
        }),
    });

    const fallbackData = await fallback.json();
    if (!fallbackData.ok) {
        console.error(`[sendMessage] plain-text fallback also failed: ${fallbackData.description}`);
    }
    return fallbackData;
}

/**
 * Send agent Markdown to a chat.
 *
 * Renders and splits: Telegram caps a message at 4096 characters after entity
 * parsing, and previously nothing checked. An over-long reply failed, the only
 * fallback matched on "can't parse entities" so it never fired, and the user was
 * left with a placeholder that never resolved.
 *
 * Returns the response for the LAST chunk, so the common single-message case
 * still hands callers a `result.message_id` exactly as before.
 *
 * @param {number|string} chatId
 * @param {string}        text    - Markdown as the agent writes it
 * @param {object}        options - extra sendMessage fields (e.g. reply_markup)
 */
export async function sendMessage(chatId, text, options = {}) {
    if (!chatId) {
        throw new Error(`[sendMessage] missing chat id : ${chatId}`);
    }

    const chunks = renderForTelegram(text);
    if (chunks.length === 0) {
        console.warn("[sendMessage] nothing to send — empty text");
        return { ok: false, description: "empty text" };
    }

    let last;
    for (const [i, chunk] of chunks.entries()) {
        if (i > 0) await sleep(CHUNK_GAP_MS);
        // A keyboard belongs on the final chunk only, or it would be buried
        // mid-reply and repeated.
        const isLast = i === chunks.length - 1;
        last = await postMessage(chatId, chunk, isLast ? options : {});
    }
    return last;
}

/**
 * Removes a message. Used to clear a placeholder that should not stay visible.
 *
 * Telegram refuses deletes older than 48h; that is not an error worth raising
 * here, so failures are swallowed after a log line.
 */
export async function deleteMessage(chatId, messageId) {
    if (!chatId || !messageId) return { ok: false };
    try {
        const response = await fetch(`${TELEGRAM_API}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
        });
        const data = await response.json();
        if (!data.ok) console.warn("[deleteMessage] failed:", data.description);
        return data;
    } catch (err) {
        console.warn("[deleteMessage] failed:", err.message);
        return { ok: false };
    }
}

/**
 * Edits an existing message in place.
 *
 * Used for messages that must stay ONE message across a state change — the OAuth
 * connect button becoming its own outcome, so the tapped button cannot be tapped
 * again. Agent replies do not go through here; they are sent fresh.
 *
 * No splitting: an edit target is a single message by definition, so an
 * over-long edit is a caller bug rather than something to paper over. Only the
 * first chunk is sent, and the truncation is logged.
 *
 * @param {number|string} chatId
 * @param {number}        messageId - message_id returned by sendMessage
 * @param {string}        text      - new content, as Markdown
 * @param {object}        options   - extra editMessageText fields
 */
export async function editMessage(chatId, messageId, text, options = {}) {
    const chunks = renderForTelegram(text);
    if (chunks.length === 0) return { ok: false, description: "empty text" };
    if (chunks.length > 1) {
        console.warn(`[editMessage] text exceeds one message; ${chunks.length - 1} chunk(s) dropped`);
    }
    const html = chunks[0];

    const response = await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: html,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...options,
        }),
    });

    const data = await response.json();
    if (data.ok) return data;

    console.warn(`[editMessage] Telegram refused (${data.error_code}): ${data.description}`);
    if (data.error_code === 429) return data;

    const fallback = await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: htmlToPlain(html),
            link_preview_options: { is_disabled: true },
            ...options,
        }),
    });
    return await fallback.json();
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
}

/**
 * Keep Telegram's native "typing…" indicator alive for the length of a turn.
 *
 * This replaces a placeholder message that read "⏳ Processing...". The
 * placeholder was worse on three counts, only one of them cosmetic:
 *
 *   - It is what every chat app already does natively, in the header, without
 *     putting a disposable bubble in the transcript the user scrolls back
 *     through later.
 *   - It consumed the chat's ~1 msg/sec budget to say nothing.
 *   - It made failure invisible. The reply was delivered by EDITING it, so any
 *     send failure left "⏳ Processing..." sitting there forever, looking like
 *     the agent had hung. A fresh reply either arrives or visibly does not.
 *
 * sendChatAction is free, is not rate-limited against messages, and Telegram
 * clears it after ~5s — hence the 4s refresh.
 *
 * Returns { stop() }. Safe to call stop() more than once.
 */
export function startTyping(chatId) {
    let stopped = false;

    const ping = () => {
        if (stopped) return;
        fetch(`${TELEGRAM_API}/sendChatAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        }).catch(() => { }); // a dropped indicator must never fail a turn
    };

    ping(); // immediately, so the badge appears without a 4s wait
    const timer = setInterval(ping, 4000);

    return {
        stop: () => {
            stopped = true; // flag first, so an in-flight callback is a no-op
            clearInterval(timer);
        },
    };
}

export { markdownToTelegramHTML };
