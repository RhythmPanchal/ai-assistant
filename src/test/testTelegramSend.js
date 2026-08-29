/**
 * Hand-run:  node src/test/testTelegramSend.js
 *
 * Guards the Telegram send path — chunking, keyboard placement, the typing
 * indicator, and the refusal to send nothing. `fetch` is stubbed, so this makes
 * no network calls and needs no .env; the token is set before the import so the
 * module's API URL builds.
 *
 * The case that matters most is the long reply. Telegram caps a message at 4096
 * characters and nothing used to check: an over-long reply failed, the only
 * fallback matched on "can't parse entities" so it never fired, and the user was
 * left looking at a placeholder that never resolved.
 */
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "TEST_TOKEN";

let passed = 0;
const failures = [];

function ok(name, condition, detail = "") {
    if (condition) passed++;
    else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

// ------------------------------------------------------------ fetch stub ----
const calls = [];
let nextResponse = () => ({ ok: true, result: { message_id: calls.length } });

globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: String(url).split("/").pop(), body });
    return { json: async () => nextResponse(body) };
};

const { sendMessage, editMessage, startTyping } = await import("../tools/telegram/sendMessage.js");

const reset = () => { calls.length = 0; };
const sends = () => calls.filter(c => c.method === "sendMessage");
const rendered = (text) => String(text).replace(/<[^>]+>/g, "").length;

// ------------------------------------------------------- an ordinary reply --

reset();
await sendMessage(123, "*Logged.* Spend 4820 < 6000 cap.");
ok("a short reply is exactly one message", sends().length === 1, `got ${sends().length}`);
ok("it is sent as HTML", sends()[0].body.parse_mode === "HTML");
ok("its comparison is escaped",
    sends()[0].body.text === "<b>Logged.</b> Spend 4820 &lt; 6000 cap.",
    sends()[0].body.text);
ok("link previews are suppressed", sends()[0].body.link_preview_options?.is_disabled === true);

// ------------------------------------------------------------ long replies --

const long = Array.from({ length: 400 }, (_, i) => `Line ${i} filler text here to add some length.`).join("\n");

reset();
await sendMessage(123, long);
ok("a long reply is split", sends().length > 1, `got ${sends().length}`);
ok("every chunk is under the 4096 cap",
    sends().every(c => rendered(c.body.text) <= 4096),
    `max = ${Math.max(...sends().map(c => rendered(c.body.text)))}`);
ok("no chunk is empty", sends().every(c => c.body.text.trim().length > 0));

// A keyboard repeated on every chunk would be tapped on the wrong one, and one
// buried mid-reply is worse than none.
reset();
await sendMessage(123, long, { reply_markup: { inline_keyboard: [] } });
const keyed = sends().filter(c => c.body.reply_markup);
ok("reply_markup appears exactly once", keyed.length === 1, `got ${keyed.length}`);
ok("reply_markup is on the final chunk", !!sends().at(-1).body.reply_markup);

// ---------------------------------------------------------- nothing to say --

reset();
const empty = await sendMessage(123, "   ");
ok("whitespace-only text sends nothing", sends().length === 0, `got ${sends().length}`);
ok("and reports not-ok", empty.ok === false);

// ------------------------------------------------------------- the fallback --
// With escaping fixed this should be unreachable, but a message that fails to
// send is invisible to the user AND the logs, so anything that is not a rate
// limit earns one plain-text retry.

reset();
let first = true;
nextResponse = () => {
    if (first) { first = false; return { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }; }
    return { ok: true, result: { message_id: 1 } };
};
await sendMessage(123, "*hi* there");
ok("a rejected message is retried once as plain text", sends().length === 2, `got ${sends().length}`);
ok("the retry drops parse_mode", sends()[1].body.parse_mode === undefined);
ok("the retry carries readable prose, not tags",
    sends()[1].body.text === "hi there",
    sends()[1].body.text);

// A 429 must NOT be retried — the message would arrive twice once the limit
// clears.
reset();
nextResponse = () => ({ ok: false, error_code: 429, description: "Too Many Requests" });
await sendMessage(123, "hello");
ok("a rate limit is not retried", sends().length === 1, `got ${sends().length}`);

nextResponse = () => ({ ok: true, result: { message_id: 1 } });

// ---------------------------------------------------------------- editing ---

reset();
await editMessage(123, 55, "Understood! I won't connect *gCalendar* for now.", {
    reply_markup: { inline_keyboard: [] },
});
const edits = calls.filter(c => c.method === "editMessageText");
ok("an edit is a single call", edits.length === 1);
ok("the edit keeps its message id", edits[0].body.message_id === 55);
ok("the edit renders its markdown", edits[0].body.text.includes("<b>gCalendar</b>"), edits[0].body.text);

// ------------------------------------------------------------ typing badge --

reset();
const typing = startTyping(123);
await new Promise(r => setTimeout(r, 50));
typing.stop();
const actions = calls.filter(c => c.method === "sendChatAction");
ok("typing starts immediately, without a 4s wait", actions.length === 1, `got ${actions.length}`);
ok("it is the typing action", actions[0].body.action === "typing");

const afterStop = calls.length;
await new Promise(r => setTimeout(r, 120));
ok("stop() is idempotent and silences further pings", calls.length === afterStop);
typing.stop();

// No placeholder message is ever posted — that is the whole point of the change.
ok("startTyping posts nothing to the transcript",
    calls.every(c => c.method !== "sendMessage"));

// ------------------------------------------------------------------ report --

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES:\n");
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
}
console.log("Telegram send path holds.\n");
