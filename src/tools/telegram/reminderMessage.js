/**
 * What a fired reminder looks like, and the two buttons under it.
 *
 * Pure — no database, no network — so the format is testable and the delivery
 * path in sendReminder.js stays about delivery.
 *
 * The old format was `"[*REMINDER*]" + message`, built in createReminders and
 * STORED in payload.text. Two things wrong with that, one cosmetic and one
 * structural:
 *
 *   - It reads as a log line, not a message: "[*REMINDER*]Take medicine pink
 *     one in morning." — no separator, asterisks that Telegram's Markdown
 *     renders as stray emphasis, and the label welded to the first word.
 *   - Presentation was baked into the row at CREATE time. A reminder written in
 *     March is delivered in June by whatever client the user is on by then, so
 *     the channel has to decide how it looks, not the scheduler. Same rule the
 *     renderer and the OUTPUT prompt block already follow.
 *
 * So the prefix is gone from storage, and stripped on the way out for rows that
 * still carry it — there is no migration, the format is simply applied at
 * delivery to old and new rows alike.
 */

// Rows written before this change. Matched loosely: the literal was
// "[*REMINDER*]" with no trailing space, but a few were hand-seeded.
const LEGACY_PREFIX = /^\s*\[\*?\s*REMINDER\s*\*?\]\s*/i;

/** Callback data is `rem:<verdict>:<jobId>` — see REMINDER_CALLBACK_CODE. */
export const REMINDER_CALLBACK_CODE = "rem";
export const REMINDER_VERDICTS = ["done", "missed"];

// Telegram caps callback_data at 64 BYTES. "rem:missed:" is 11 and a Mongo
// ObjectId hex is 24, so this is 35 — comfortable, and it stays that way only
// because the userId is deliberately NOT in here. Identity comes from
// callback_query.from.id; a value that round-trips through the client is not
// evidence of who sent it.
const MAX_CALLBACK_BYTES = 64;

export function buildReminderCallbackData(verdict, jobId) {
    const data = `${REMINDER_CALLBACK_CODE}:${verdict}:${jobId}`;
    if (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) {
        // Telegram rejects the whole sendMessage, so the reminder would not
        // arrive at all. Better to deliver it without buttons.
        throw new Error(`[reminderMessage] callback_data too long (${data.length}): ${data}`);
    }
    return data;
}

/**
 * Parse `rem:done:<id>`. Returns null for anything that is not a well-formed
 * reminder callback, so the handler can fall through instead of acting on a
 * half-understood string.
 */
export function parseReminderCallback(data) {
    const parts = String(data ?? "").split(":");
    if (parts.length !== 3) return null;
    const [code, verdict, jobId] = parts;
    if (code !== REMINDER_CALLBACK_CODE) return null;
    if (!REMINDER_VERDICTS.includes(verdict)) return null;
    // 24 hex characters, because that is what it is going to be cast to. A
    // malformed id is refused here rather than thrown at ObjectId downstream.
    if (!/^[0-9a-f]{24}$/i.test(jobId)) return null;
    return { verdict, jobId };
}

/** The reminder sentence, with any stored prefix taken off. */
export function reminderText(text) {
    return String(text ?? "").replace(LEGACY_PREFIX, "").trim();
}

/**
 * The delivered message, as Markdown for renderMarkdown to turn into HTML.
 *
 * Two lines on purpose. The label is what makes a reminder scannable in a chat
 * that is otherwise conversation, and putting it on its own line keeps it from
 * running into the sentence the way the old format did. The clock is the one
 * emoji here and it earns its place as a type marker — Telegram gives no other
 * way to distinguish a pushed message from a reply.
 */
export function formatReminder(text) {
    const body = reminderText(text);
    if (!body) return null;
    return `⏰ *Reminder*\n${body}`;
}

/**
 * Done / Missed.
 *
 * "Missed" rather than "Skip" or "Not yet": the user's meaning is that the
 * window has passed and the thing cannot be done now, which is a different
 * fact from declining to answer. Not answering at all is already expressible —
 * they just ignore the message, and the night routine asks.
 */
export function reminderKeyboard(jobId) {
    return {
        inline_keyboard: [[
            { text: "✓ Done", callback_data: buildReminderCallbackData("done", jobId) },
            { text: "✗ Missed", callback_data: buildReminderCallbackData("missed", jobId) },
        ]],
    };
}

/**
 * What the message becomes once a button is tapped.
 *
 * The buttons are removed and the outcome is written into the text, so the
 * chat history reads as a record rather than a row of buttons whose state is
 * invisible. Scrolling back a week should still say what happened.
 */
export function formatAnsweredReminder(text, verdict) {
    const body = reminderText(text);
    const mark = verdict === "done" ? "✓ *Done*" : "✗ *Missed*";
    return `⏰ *Reminder*\n${body}\n\n${mark}`;
}
