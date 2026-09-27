/**
 * Hand-run:  node src/test/testReminderButtons.js
 *
 * Guards the reminder message, its Done / Missed buttons, the callback parsing
 * and the unanswered-reminder block. Nothing here connects to anything: `fetch`
 * is stubbed for the delivery check and no query is issued.
 *
 * The case that matters most is `isUnattended`. A recurring reminder fires
 * against ONE row every day, so a stored answer has to say which firing it
 * belongs to — without that, yesterday's "Done" makes tonight's firing look
 * answered and the night routine never asks.
 */
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "TEST_TOKEN";

// Loaded only because the knowledge module imports getDB, and mongoClient.js
// constructs its MongoClient at module load, which needs MONGO_DB_URI. Same
// reason as testNightLogBlock.js. Nothing here connects.
import "dotenv/config";
import assert from "node:assert";
import {
    formatReminder, formatAnsweredReminder, reminderKeyboard, reminderText,
    parseReminderCallback, buildReminderCallbackData, REMINDER_CALLBACK_CODE,
} from "../tools/telegram/reminderMessage.js";
import {
    isUnattended, renderUnattendedReminders,
} from "../knowledge/unattendedRemindersKnowledge.js";
import { markdownToTelegramHTML } from "../tools/telegram/renderMarkdown.js";

let passed = 0;
const failures = [];
function check(name, actual, expected) {
    try { assert.deepStrictEqual(actual, expected); passed++; }
    catch {
        failures.push(`${name}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
    }
}
function ok(name, cond, detail = "") {
    if (cond) passed++; else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

// ------------------------------------------------------------------ format ---

check("the stored legacy prefix is stripped",
    reminderText("[*REMINDER*]Take medicine pink one in morning."),
    "Take medicine pink one in morning.");

check("a prefix without asterisks is stripped too",
    reminderText("[REMINDER] Call Masi"), "Call Masi");

check("text with no prefix is untouched", reminderText("Call Masi"), "Call Masi");

check("the delivered message labels itself on its own line",
    formatReminder("Take medicine pink one in morning."),
    "⏰ *Reminder*\nTake medicine pink one in morning.");

check("a legacy row renders in the new format",
    formatReminder("[*REMINDER*]Take medicine pink one in morning."),
    "⏰ *Reminder*\nTake medicine pink one in morning.");

check("empty text yields no message at all", formatReminder("   "), null);
check("null text yields no message", formatReminder(null), null);

// The old format's own asterisks were read as emphasis by the renderer, which
// is how "[*REMINDER*]x" became "[<b>REMINDER</b>]x" on screen.
const renderedOld = markdownToTelegramHTML("[*REMINDER*]Take medicine.");
ok("the old format really did render stray bold", renderedOld.includes("<b>REMINDER</b>"), renderedOld);

const renderedNew = markdownToTelegramHTML(formatReminder("Take medicine."));
check("the new format renders a bold label and a plain body",
    renderedNew, "⏰ <b>Reminder</b>\nTake medicine.");

// A reminder sentence is user/model text and may contain anything.
const risky = markdownToTelegramHTML(formatReminder("Pay rent if balance < 5000 & tell Ma"));
ok("a reminder body with < and & is escaped",
    risky.includes("&lt; 5000 &amp;"), risky);
ok("and keeps its label", risky.startsWith("⏰ <b>Reminder</b>"), risky);

// ----------------------------------------------------------------- buttons ---

const ID = "68d266892a7612ade8d379c6";
const kb = reminderKeyboard(ID);

check("two buttons, one row", kb.inline_keyboard.length, 1);
check("labelled Done and Missed",
    kb.inline_keyboard[0].map(b => b.text), ["✓ Done", "✗ Missed"]);
check("carrying the job id",
    kb.inline_keyboard[0].map(b => b.callback_data),
    [`rem:done:${ID}`, `rem:missed:${ID}`]);

// Telegram rejects the whole sendMessage over 64 bytes, so the reminder would
// not arrive at all.
ok("callback data is well inside Telegram's 64-byte cap",
    kb.inline_keyboard[0].every(b => Buffer.byteLength(b.callback_data, "utf8") <= 64),
    kb.inline_keyboard[0].map(b => Buffer.byteLength(b.callback_data)).join(","));

// The userId is deliberately absent: a value that round-trips through the client
// is not evidence of who sent it, and leaving it out is also what keeps this
// under the cap.
ok("no userId is embedded in callback data",
    kb.inline_keyboard[0].every(b => b.callback_data.split(":").length === 3));

let threw = false;
try { buildReminderCallbackData("done", "x".repeat(80)); } catch { threw = true; }
ok("an over-long id is refused rather than silently sent", threw);

// ------------------------------------------------------------------ parsing --

check("a done tap parses", parseReminderCallback(`rem:done:${ID}`), { verdict: "done", jobId: ID });
check("a missed tap parses", parseReminderCallback(`rem:missed:${ID}`), { verdict: "missed", jobId: ID });
check("the code is checked", parseReminderCallback(`dismiss:done:${ID}`), null);
check("an unknown verdict is refused", parseReminderCallback(`rem:maybe:${ID}`), null);
check("a non-hex id is refused", parseReminderCallback("rem:done:../../etc/passwd"), null);
check("a short id is refused", parseReminderCallback("rem:done:abc"), null);
check("extra segments are refused", parseReminderCallback(`rem:done:${ID}:extra`), null);
check("empty data is refused", parseReminderCallback(""), null);
check("null data is refused", parseReminderCallback(null), null);
check("the exported code matches the wire format", REMINDER_CALLBACK_CODE, "rem");

// ----------------------------------------------------------------- answered --

check("a tapped reminder records the outcome in its text",
    formatAnsweredReminder("Take medicine.", "done"),
    "⏰ *Reminder*\nTake medicine.\n\n✓ *Done*");
check("a missed one says so",
    formatAnsweredReminder("Take medicine.", "missed"),
    "⏰ *Reminder*\nTake medicine.\n\n✗ *Missed*");
check("a legacy row's text is cleaned when answered too",
    formatAnsweredReminder("[*REMINDER*]Take medicine.", "done"),
    "⏰ *Reminder*\nTake medicine.\n\n✓ *Done*");

// --------------------------------------------------------- isUnattended ------
// The whole correctness of the night block.

const day = { start: new Date("2026-09-27T00:00:00+05:30"), end: new Date("2026-09-28T00:00:00+05:30") };
const firedToday = new Date("2026-09-27T21:00:00+05:30");
const firedYesterday = new Date("2026-09-26T21:00:00+05:30");

ok("fired today and never answered is unattended",
    isUnattended({ lastExecutedAt: firedToday, reminderResponse: null }, day));

ok("never fired is not unattended",
    !isUnattended({ lastExecutedAt: null, reminderResponse: null }, day));

ok("answered for today's firing is attended",
    !isUnattended({
        lastExecutedAt: firedToday,
        reminderResponse: { status: "completed", forExecutionAt: firedToday },
    }, day));

ok("marked missed for today's firing is also attended",
    !isUnattended({
        lastExecutedAt: firedToday,
        reminderResponse: { status: "missed", forExecutionAt: firedToday },
    }, day));

// THE case. A daily reminder answered yesterday, fired again today, untouched.
ok("yesterday's answer does NOT cover today's firing",
    isUnattended({
        lastExecutedAt: firedToday,
        reminderResponse: { status: "completed", forExecutionAt: firedYesterday },
    }, day),
    "a recurring reminder would never be asked about again");

ok("a firing outside the log day is ignored",
    !isUnattended({ lastExecutedAt: firedYesterday, reminderResponse: null }, day));

ok("a response object with no status counts as unanswered",
    isUnattended({ lastExecutedAt: firedToday, reminderResponse: {} }, day));

ok("undefined job is not unattended", !isUnattended(undefined, day));

// ------------------------------------------------------------------- block ---

check("no unanswered reminders means no block at all",
    renderUnattendedReminders([]), null);

const block = renderUnattendedReminders([
    { _id: ID, title: "Medicine", payload: { text: "[*REMINDER*]Take medicine" }, lastExecutedAt: firedToday, recurring: true },
    { _id: "68d266892a7612ade8d379c7", title: "Masi", payload: { text: "Call Masi" }, lastExecutedAt: new Date("2026-09-27T18:30:00+05:30"), recurring: false },
], { timeZone: "Asia/Kolkata" });

ok("the block names the tool the model must call", block.includes("answerReminder"), block);
ok("it carries every _id, so no fetch is needed first",
    block.includes(ID) && block.includes("68d266892a7612ade8d379c7"), block);
ok("it shows the local firing time", block.includes("21:00") && block.includes("18:30"), block);
ok("it strips the legacy prefix", !block.includes("[*REMINDER*]"), block);
ok("it marks a recurring reminder", block.includes("(recurring)"), block);
ok("it forbids guessing an outcome", /[Dd]o not guess/.test(block), block);
ok("it forbids asking twice", /once|second time/.test(block), block);

// ---------------------------------------------------------------- delivery ---
// sendReminder attaches the keyboard and goes through the shared sender, so the
// body is escaped and split like any other message.

const calls = [];
globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
    return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
};

const { sendMessage } = await import("../tools/telegram/sendMessage.js");
const { reminderKeyboard: kbFn } = await import("../tools/telegram/reminderMessage.js");

calls.length = 0;
await sendMessage(999, formatReminder("Pay rent if balance < 5000"), { reply_markup: kbFn(ID) });
const sent = calls.filter(c => c.method === "sendMessage");
ok("one message with the keyboard", sent.length === 1 && !!sent[0].body.reply_markup, `${sent.length}`);
ok("the body is escaped HTML", sent[0].body.text.includes("&lt; 5000"), sent[0].body.text);
ok("the label survives rendering", sent[0].body.text.startsWith("⏰ <b>Reminder</b>"), sent[0].body.text);
check("both buttons are on the wire",
    sent[0].body.reply_markup.inline_keyboard[0].map(b => b.text), ["✓ Done", "✗ Missed"]);

// ------------------------------------------------------------------ report ---

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES:\n");
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
}
console.log("Reminder buttons hold.\n");
