/**
 * Markdown (as the agent writes it) -> Telegram-safe HTML.
 *
 * The engine returns a plain string and knows nothing about Telegram; this is
 * the whole of the channel's presentation layer. Keep it that way — a mobile
 * client will want the same string rendered its own way, so nothing here may
 * leak back into the prompt or the agent loop.
 *
 * Why a tokenizer instead of a chain of .replace() calls:
 *
 * The previous version ran seven regexes over one shared string and injected
 * tags without escaping first. Two consequences, both live in production:
 *
 *   1. "budget < 5000 & you're at 4820" reached Telegram with a raw `<` and `&`.
 *      Telegram answers "can't parse entities", and the fallback resends the
 *      message as plain text — so ONE arithmetic comparison silently stripped
 *      the formatting from the entire reply. `<` is not exotic here; the agent
 *      writes comparisons and `->` arrows constantly.
 *   2. Emphasis regexes ran over already-converted code spans, so
 *      `Formula \`3 * 4 * 5\`` became <code>3 <b> 4 </b> 5</code>. Telegram's
 *      entity model explicitly forbids that: bold/italic/underline/strike/
 *      spoiler "can contain and can be part of any other entities, except pre
 *      and code".
 *
 * So: cut the spans that must stay literal OUT of the string first, escape what
 * remains, apply emphasis to that, and only then put the literal spans back —
 * escaped, and never re-scanned. A token can't be corrupted by a later pass if
 * it isn't in the string during that pass.
 *
 * Reference: https://core.telegram.org/bots/api#formatting-options
 */

// Telegram's supported tag set is fixed and small. <ul>/<ol>/<li> are NOT in it
// ("Only the tags mentioned above are currently supported"), so bullets are
// rendered as text with a bullet glyph rather than as markup.
const BULLET = "•";

// A private-use code point: never produced by a model, never meaningful to
// Telegram, so it is a placeholder no later pass can collide with. Digits only
// between the markers keeps the pattern trivially unambiguous. Anything the
// caller somehow smuggled in is stripped at the end, so a token reference
// cannot be forged from the outside.
const NUL = "\uE000";
const tokenRef = (i) => `${NUL}${i}${NUL}`;
const TOKEN_PATTERN = /\uE000(\d+)\uE000/g;

// Blockquote markers are found BEFORE escaping (a raw ">" becomes "&gt;" and is
// then indistinguishable from a quoted chevron the user typed), so the decision
// is recorded per line with a sentinel and acted on after escaping.
const QUOTE_MARK = `${NUL}q${NUL}`;

/**
 * The one escaping rule, applied everywhere including inside code.
 *
 * Telegram: "All <, > and & symbols that are not a part of a tag or an HTML
 * entity must be replaced with the corresponding HTML entities." There is no
 * exemption for code content — which is the opposite of MarkdownV2 and the
 * easiest thing to get wrong.
 *
 * Ampersand first, or the & of an escape we just wrote gets escaped again.
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Only these schemes become links.
 *
 * The agent composes URLs from records it read, so a link href is not
 * necessarily a string we wrote. `javascript:` and `data:` are refused rather
 * than sanitised — a link we cannot vouch for is shown as its own text, which
 * loses a click and risks nothing.
 *
 * tg: is allowed because tg://user?id= is Telegram's own mention form.
 */
const SAFE_SCHEME = /^(https?:\/\/|tg:\/\/|mailto:)/i;

function escapeAttr(url) {
    // Same rule as text, plus the quote that would end the attribute. An "&" in
    // a query string is not part of a tag, so ?a=1&b=2 must be written
    // ?a=1&amp;b=2 for the href to survive parsing intact.
    return escapeHtml(url).replace(/"/g, "&quot;");
}

/**
 * Pull everything that must survive verbatim out of the string.
 *
 * Order matters and is not arbitrary: fenced blocks before inline code (a fence
 * contains backticks), and both before links (a code span may contain what
 * looks like link syntax).
 */
function extractLiterals(text, tokens) {
    let out = text;

    const take = (value) => {
        tokens.push(value);
        return tokenRef(tokens.length - 1);
    };

    // Fenced block. The language, when given, must go on a NESTED <code> tag:
    // "Programming language can't be specified for standalone code tags."
    out = out.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (_, lang, code) => {
        const body = escapeHtml(code.replace(/\n$/, ""));
        const cls = lang ? ` class="language-${escapeAttr(lang.toLowerCase())}"` : "";
        return take(`<pre><code${cls}>${body}</code></pre>`);
    });

    // Inline code. Kept to a single line so an unmatched backtick swallows a
    // word rather than the rest of the message.
    out = out.replace(/`([^`\n]+)`/g, (_, code) => take(`<code>${escapeHtml(code)}</code>`));

    // [label](url). The label is escaped but NOT formatted — Telegram forbids a
    // link inside a link, and nested emphasis inside one buys nothing here.
    out = out.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, url) => {
        if (!SAFE_SCHEME.test(url)) return whole; // left as literal text, escaped later
        const text = escapeHtml(label.trim() || url);
        return take(`<a href="${escapeAttr(url)}">${text}</a>`);
    });

    return out;
}

/**
 * Emphasis, applied only to text with literals already removed.
 *
 * Every pattern is newline-bounded ([^\n]) so an unclosed marker corrupts one
 * line instead of running to the end of the message. Longer markers run first
 * or the shorter one eats half of them.
 */
function applyEmphasis(text) {
    return text
        .replace(/\*\*\*([^\n*]+)\*\*\*/g, "<b><i>$1</i></b>")
        .replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>")
        // Telegram's own Markdown reads single-asterisk as BOLD, and the prompt
        // asks for *bold*. Deliberately not italic.
        .replace(/(?<![\w*])\*([^\n*]+)\*(?![\w*])/g, "<b>$1</b>")
        // MarkdownV2 spells underline __x__; standard Markdown spells bold. The
        // channel wins.
        .replace(/(?<![\w_])__([^\n_]+)__(?![\w_])/g, "<u>$1</u>")
        .replace(/(?<![\w_])_([^\n_]+)_(?![\w_])/g, "<i>$1</i>")
        .replace(/~~([^\n~]+)~~/g, "<s>$1</s>")
        .replace(/\|\|([^\n|]+)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");
}

/**
 * Wrap runs of quoted lines. Consecutive quoted lines form ONE blockquote:
 * "blockquote and expandable_blockquote entities can't be nested", and a
 * per-line quote would also read as a stack of separate quotes in the client.
 */
function wrapQuotes(lines) {
    const out = [];
    let buffer = null;

    const flush = () => {
        if (!buffer) return;
        out.push(`<blockquote>${buffer.join("\n")}</blockquote>`);
        buffer = null;
    };

    for (const line of lines) {
        if (line.startsWith(QUOTE_MARK)) {
            buffer ??= [];
            buffer.push(line.slice(QUOTE_MARK.length));
        } else {
            flush();
            out.push(line);
        }
    }
    flush();
    return out;
}

/**
 * Convert one message's worth of Markdown. Callers that might exceed Telegram's
 * length cap should go through renderForTelegram, which splits first.
 */
export function markdownToTelegramHTML(text) {
    if (!text) return "";

    const tokens = [];
    // Strip any sentinel the caller supplied BEFORE tokens are minted, or text
    // containing one could address a token slot it does not own. Costs one pass
    // over the string and makes the placeholder scheme closed.
    let result = String(text).replace(/\r\n/g, "\n").replaceAll(NUL, "");

    result = extractLiterals(result, tokens);

    // The prompt tells the model never to escape, but it intermittently emits
    // MarkdownV2 escapes anyway. Stripping them here rather than shipping "\."
    // to the user. Runs after literal extraction so a backslash inside code
    // survives.
    //
    // Deliberately WIDER than MarkdownV2's official escape set
    // (_*[]()~`>#+-=|{}.!). Models over-escape: a real reply arrived with "\?",
    // which is not in that set, and a set-based strip left the backslash
    // visible to the user. Any punctuation qualifies; \w and \s do not, so a
    // Windows path like C:\Users\test is untouched.
    result = result.replace(/\\([^\w\s])/g, "$1");

    // Quote markers, recorded before escaping turns ">" into "&gt;". Nested
    // ">>" is flattened to one level, since Telegram cannot express the second.
    result = result
        .split("\n")
        .map((line) => line.replace(/^[ \t]*>[ \t]?>*[ \t]?/, QUOTE_MARK))
        .join("\n");

    result = escapeHtml(result);
    result = applyEmphasis(result);

    // Bullets as text, since Telegram has no list tags. "*" is excluded as a
    // marker: it is bold in this dialect, and applyEmphasis has already run.
    let lines = result
        .split("\n")
        .map((line) => line.replace(/^([ \t]*)[-+][ \t]+/, `$1${BULLET} `));

    lines = wrapQuotes(lines);
    result = lines.join("\n");

    // Literals last, so nothing above could have rewritten their insides.
    return result.replace(TOKEN_PATTERN, (_, i) => tokens[Number(i)] ?? "");
}

// Telegram's cap is 4096 "after entities parsing" — the RENDERED text, not the
// HTML we send, so tags are free but "&amp;" counts as one character. Rendering
// only ever removes markup characters, so rendered length <= source length and
// splitting the SOURCE under this budget is sufficient. Splitting the source
// also means each chunk is parsed independently and cannot end mid-tag, which
// splitting the HTML could not guarantee without re-balancing open entities.
const TELEGRAM_LIMIT = 4096;
const CHUNK_BUDGET = 3900;

/**
 * Split Markdown into chunks that will each render under the cap.
 *
 * Prefers the seam a reader would not notice: paragraph, then line, then a hard
 * cut only if a single line is somehow longer than the budget. Fenced code
 * blocks are kept whole where they fit, because a fence split across two
 * messages renders as garbage in both.
 */
export function splitMarkdown(text, budget = CHUNK_BUDGET) {
    const source = String(text ?? "");
    if (source.length <= budget) return source.trim() ? [source] : [];

    const chunks = [];
    let current = "";

    const push = () => {
        if (current.trim()) chunks.push(current.trim());
        current = "";
    };

    // Paragraphs first, but never break a fenced block: split on blank lines
    // only outside fences.
    const blocks = [];
    let fenceOpen = false;
    let block = [];
    for (const line of source.split("\n")) {
        if (/^\s*```/.test(line)) fenceOpen = !fenceOpen;
        if (!fenceOpen && line.trim() === "") {
            blocks.push(block.join("\n"));
            block = [];
        } else {
            block.push(line);
        }
    }
    blocks.push(block.join("\n"));

    for (const para of blocks) {
        if (!para.trim()) continue;

        if (current && current.length + para.length + 2 > budget) push();

        if (para.length <= budget) {
            current = current ? `${current}\n\n${para}` : para;
            continue;
        }

        // One paragraph over budget — fall to line granularity.
        for (const line of para.split("\n")) {
            if (current && current.length + line.length + 1 > budget) push();
            if (line.length <= budget) {
                current = current ? `${current}\n${line}` : line;
                continue;
            }
            // A single line over budget. Nothing graceful left; cut it.
            for (let i = 0; i < line.length; i += budget) {
                push();
                chunks.push(line.slice(i, i + budget));
            }
        }
    }

    push();
    return chunks;
}

/**
 * The entry point senders should use: Markdown in, ready-to-send HTML chunks
 * out. One element for almost every reply; more only when the agent genuinely
 * ran long.
 */
export function renderForTelegram(text) {
    return splitMarkdown(text).map(markdownToTelegramHTML).filter(Boolean);
}

/**
 * Rendered length, for the cap that counts entities rather than markup.
 * Exported for tests — nothing in the send path needs it, because splitting
 * happens on the source.
 */
export function renderedLength(html) {
    return String(html ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;|&gt;|&quot;/g, "x")
        .replace(/&amp;/g, "x").length;
}

export { TELEGRAM_LIMIT, escapeHtml };
