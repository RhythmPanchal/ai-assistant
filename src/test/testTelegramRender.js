/**
 * Hand-run:  node src/test/testTelegramRender.js
 *
 * Guards the Markdown -> Telegram-HTML renderer. Pure string work, no .env, no
 * network, no DB.
 *
 * Everything asserted here is a rule from
 * https://core.telegram.org/bots/api#formatting-options, and most of the cases
 * are regressions from the previous implementation — a raw "<" in a reply cost
 * that whole message its formatting, because Telegram answers "can't parse
 * entities" and the send path silently retries as plain text. That failure is
 * invisible in logs and looks like the model just stopped using bold.
 */
import assert from "node:assert";
import {
    markdownToTelegramHTML,
    renderForTelegram,
    splitMarkdown,
    renderedLength,
    TELEGRAM_LIMIT,
} from "../tools/telegram/renderMarkdown.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
    try {
        assert.strictEqual(actual, expected);
        passed++;
    } catch {
        failures.push(`${name}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
    }
}

function ok(name, condition, detail = "") {
    if (condition) passed++;
    else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

const md = markdownToTelegramHTML;

// ---------------------------------------------------------------- escaping --
// The rule with no exceptions: <, > and & that are not part of a tag must be
// entities. This is the bug that silently downgraded whole replies.

check("bare < and & are escaped",
    md("budget < 5000 & you're at 4820"),
    "budget &lt; 5000 &amp; you're at 4820");

check("arrows survive",
    md("Spend 3200 -> 4800. Ratio 1<2"),
    "Spend 3200 -&gt; 4800. Ratio 1&lt;2");

check("ampersand escaped before angle brackets (no double-escape)",
    md("a & b < c"),
    "a &amp; b &lt; c");

check("user text that looks like markup is inert",
    md("You wrote: <b>hello</b> in your note"),
    "You wrote: &lt;b&gt;hello&lt;/b&gt; in your note");

// Telegram gives code content NO exemption from escaping — the opposite of
// MarkdownV2, and the easiest thing in the whole spec to get wrong.
check("escaping applies inside inline code",
    md("Filter `{ $lt: 500 & up }`"),
    "Filter <code>{ $lt: 500 &amp; up }</code>");

check("escaping applies inside fenced code",
    md("```\nif (a < b && c) {}\n```"),
    "<pre><code>if (a &lt; b &amp;&amp; c) {}</code></pre>");

// ------------------------------------------------------------ code is inert --
// "bold, italic, underline, strikethrough, and spoiler entities can contain and
// can be part of any other entities, except pre and code."

check("emphasis does NOT bleed into inline code",
    md("Formula `3 * 4 * 5` = 60"),
    "Formula <code>3 * 4 * 5</code> = 60");

check("underscores in an id are not italics",
    md("Row `user_id_1136575387` updated"),
    "Row <code>user_id_1136575387</code> updated");

check("emphasis does NOT bleed into fenced code",
    md("```\nconst a = *x* + _y_;\n```"),
    "<pre><code>const a = *x* + _y_;</code></pre>");

check("fenced language uses the nested code tag",
    md("```js\nlet a = 1;\n```"),
    '<pre><code class="language-js">let a = 1;</code></pre>');

// -------------------------------------------------------------- emphasis ----

check("single asterisk is BOLD in this dialect", md("*Overspent* today"), "<b>Overspent</b> today");
check("double asterisk is bold", md("**Overspent** today"), "<b>Overspent</b> today");
check("underscore is italic", md("_food_ this week"), "<i>food</i> this week");
check("triple asterisk is bold italic", md("***urgent***"), "<b><i>urgent</i></b>");
check("double underscore is underline", md("__noted__"), "<u>noted</u>");
check("tilde is strikethrough", md("~~cancelled~~"), "<s>cancelled</s>");
check("pipes are spoiler", md("||surprise||"), "<tg-spoiler>surprise</tg-spoiler>");

check("an unclosed marker damages one line only",
    md("You spent *4820 on food\nAnd *2000* on rent"),
    "You spent *4820 on food\nAnd <b>2000</b> on rent");

check("snake_case mid-word is not italicised",
    md("the user_id_field stays"),
    "the user_id_field stays");

// --------------------------------------------------------------- bullets ----
// No <ul>/<ol>/<li> in HTML parse mode, so bullets are text.

check("dash bullets become glyphs",
    md("- Gym at 7\n- Standup at 10"),
    "• Gym at 7\n• Standup at 10");

check("bullet lines keep their emphasis",
    md("- *Ship* the PR"),
    "• <b>Ship</b> the PR");

check("indented bullets keep indentation",
    md("- top\n  - nested"),
    "• top\n  • nested");

check("a heading degrades to bold rather than a literal #",
    md("## Today\n- gym"),
    "<b>Today</b>\n\u2022 gym");

check("closing hashes are not left behind",
    md("### Summary ###"),
    "<b>Summary</b>");

check("a hash mid-sentence is untouched",
    md("issue #42 is open"),
    "issue #42 is open");

check("a hash inside code is untouched",
    md("`#hashtag`"),
    "<code>#hashtag</code>");

ok("no list tags are ever emitted",
    !/<\/?(ul|ol|li)\b/.test(md("- a\n- b\n1. c")),
    md("- a\n- b\n1. c"));

// ------------------------------------------------------------------ links ---

check("markdown link becomes an anchor",
    md("See [the docs](https://core.telegram.org/bots/api) for more"),
    'See <a href="https://core.telegram.org/bots/api">the docs</a> for more');

check("ampersand in a query string is escaped in href",
    md("[report](https://x.com/r?a=1&b=2)"),
    '<a href="https://x.com/r?a=1&amp;b=2">report</a>');

check("javascript: is refused and shown as text",
    md("[click](javascript:alert(1))"),
    "[click](javascript:alert(1))");

ok("refused link emits no anchor tag",
    !md("[click](javascript:alert(1))").includes("<a "));

// ------------------------------------------------------------- blockquote ---

check("consecutive quoted lines form ONE blockquote",
    md("> line one\n> line two"),
    "<blockquote>line one\nline two</blockquote>");

check("nested quotes are flattened (Telegram cannot nest them)",
    md(">> deep"),
    "<blockquote>deep</blockquote>");

ok("blockquotes are never nested",
    !/<blockquote>[\s\S]*<blockquote>/.test(md("> a\n>> b\n> c")),
    md("> a\n>> b\n> c"));

check("a chevron mid-sentence is not a quote",
    md("value a > b here"),
    "value a &gt; b here");

// ------------------------------------------------------ stray escapes -------
// The prompt says never escape; the model does it anyway. Those must not reach
// the user as literal backslashes.

check("MarkdownV2 escapes are stripped",
    md("Sorry, I ran into an error\\. Try again\\!"),
    "Sorry, I ran into an error. Try again!");

check("a backslash inside code survives",
    md("Path `C:\\Users\\test`"),
    "Path <code>C:\\Users\\test</code>");

// Models over-escape beyond MarkdownV2's official set. A real reply arrived
// with "\?" and the old set-based strip left the backslash on screen.
check("over-escaped punctuation outside the official set is stripped",
    md("How would you like to proceed\\? 50\\% done\\; ok\\:"),
    "How would you like to proceed? 50% done; ok:");

check("a Windows path outside code keeps its backslashes",
    md("Saved to C:\\Users\\test"),
    "Saved to C:\\Users\\test");

// -------------------------------------------------------------- sentinels ---

ok("a caller-supplied sentinel cannot address a token slot",
    !md("\uE0000\uE000 and `real`").includes("<code>\uE000"),
    JSON.stringify(md("\uE0000\uE000 and `real`")));

ok("no private-use sentinel leaks into output",
    !md("- a\n> b\n`c`\n[d](https://e.com)").includes("\uE000"));

// ----------------------------------------------------------------- length ---

check("empty input is empty output", md(""), "");
check("null input is empty output", md(null), "");
ok("blank input yields no messages", renderForTelegram("   ").length === 0);

const long = Array.from({ length: 400 }, (_, i) => `Line ${i} with some filler text to add length.`).join("\n");
const chunks = renderForTelegram(long);
ok("a long reply is split into several messages", chunks.length > 1, `got ${chunks.length}`);
ok("every chunk renders under Telegram's cap",
    chunks.every(c => renderedLength(c) <= TELEGRAM_LIMIT),
    `max rendered = ${Math.max(...chunks.map(renderedLength))}`);
ok("splitting loses no lines",
    chunks.join("\n").split("\n").filter(l => l.trim()).length === 400);

// A fence must never be cut in half — it would render as garbage in both halves.
const withFence = "intro\n\n```\n" + "x".repeat(3000) + "\n```\n\n" + "tail ".repeat(400);
const fenceChunks = splitMarkdown(withFence);
ok("a fenced block is not split across messages",
    fenceChunks.every(c => (c.match(/```/g) || []).length % 2 === 0),
    fenceChunks.map(c => (c.match(/```/g) || []).length).join(","));

ok("balanced tags in every chunk",
    renderForTelegram(long).every(c => (c.match(/<b>/g) || []).length === (c.match(/<\/b>/g) || []).length));

// ------------------------------------------------------------- realistic ----

const reply = [
    "*Logged.* Dinner at 2100 kcal — you're under budget.",
    "",
    "- Protein: 130g",
    "- Spend so far: 4820 < 6000 cap",
    "",
    "Row `expense_8842` updated.",
].join("\n");

const rendered = md(reply);
ok("a realistic reply has no unescaped angle bracket outside a tag",
    !/(^|[^<>])<(?![a-z/])/.test(rendered.replace(/<\/?(b|i|u|s|code|pre|a|blockquote|tg-spoiler)\b[^>]*>/g, "")),
    rendered);
ok("a realistic reply keeps its bold", rendered.includes("<b>Logged.</b>"), rendered);
ok("a realistic reply escapes its comparison", rendered.includes("4820 &lt; 6000"), rendered);

// ------------------------------------------------------------------ report --

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES:\n");
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
}
console.log("All Telegram render guards hold.\n");
