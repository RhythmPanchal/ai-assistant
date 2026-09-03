/**
 * Hand-run:  node src/test/testTelegramLive.js <chatId> [--dry] [--token=<token>]
 *
 * The one test here that talks to real Telegram. Everything else in this
 * directory stubs `fetch`; this sends actual messages to an actual chat so the
 * formatting can be looked at on a phone, which is the only way to confirm the
 * renderer end-to-end.
 *
 *   node src/test/testTelegramLive.js 1136575387
 *   node src/test/testTelegramLive.js 1136575387 --dry
 *   node src/test/testTelegramLive.js 1136575387 --token=123:ABC   # test bot
 *
 * --dry prints the exact HTTP payload for each message and sends nothing. It
 * needs no network at all, so it is the mode that works from a corporate
 * network where api.telegram.org is blocked.
 *
 * No database. sendMessage only imports the renderer, so this exercises the
 * whole presentation layer without Mongo, an LLM key, or the agent loop.
 */
import "dotenv/config";

const args = process.argv.slice(2);
const chatId = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry");
const tokenArg = args.find((a) => a.startsWith("--token="))?.slice("--token=".length);

if (tokenArg) process.env.TELEGRAM_BOT_TOKEN = tokenArg;
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!chatId) {
    console.error(`
Usage: node src/test/testTelegramLive.js <chatId> [--dry] [--token=<token>]

  <chatId>   where to send. Message your bot, then read it from
             https://api.telegram.org/bot<token>/getUpdates
  --dry      print payloads instead of sending (no network needed)
  --token=   override TELEGRAM_BOT_TOKEN, e.g. to use a throwaway test bot
`);
    process.exit(1);
}

if (!token && !dryRun) {
    console.error("No TELEGRAM_BOT_TOKEN in .env and no --token given. Use --dry to preview instead.");
    process.exit(1);
}

// The token must be in the environment BEFORE sendMessage is imported — it
// builds its API URL at module load.
const { sendMessage } = await import("../tools/telegram/sendMessage.js");
const { renderForTelegram } = await import("../tools/telegram/renderMarkdown.js");

/**
 * Distinguish "Telegram said no" from "something in front of Telegram said no".
 *
 * A corporate proxy that blocks the domain answers with an HTML block page, not
 * JSON, so the usual `data.description` is undefined and the failure surfaces as
 * an unhelpful parse error. Naming the proxy here saves the next person an hour
 * of chasing a certificate problem that does not exist.
 */
function describeBlock(status, headers, body) {
    const isHtml = (headers.get("content-type") || "").includes("text/html");
    const proxied = headers.has("x-direct-response") || /goskope|netskope|zscaler|forcepoint|bluecoat/i.test(body);

    if (!isHtml && !proxied) return null;

    const vendor = /goskope|netskope/i.test(body) || headers.has("x-direct-response") ? "Netskope" : "a web proxy";
    return [
        `api.telegram.org is blocked by ${vendor} on this network (HTTP ${status}, HTML block page).`,
        "",
        "This is a POLICY block, not a TLS or certificate problem. The proxy's CA is",
        "already trusted — the handshake succeeds and the block page comes back over it,",
        "so adding a certificate or setting NODE_EXTRA_CA_CERTS changes nothing.",
        "",
        "What actually works:",
        "  - run this from a network without the proxy (personal hotspot), or",
        "  - ask IT to allowlist api.telegram.org for this machine, or",
        "  - use --dry here to check the rendering without sending.",
    ].join("\n");
}

async function callApi(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
    });

    const body = await response.text();
    const blocked = describeBlock(response.status, response.headers, body);
    if (blocked) {
        const err = new Error("BLOCKED");
        err.explanation = blocked;
        throw err;
    }

    try {
        return JSON.parse(body);
    } catch {
        throw new Error(`Non-JSON reply (HTTP ${response.status}): ${body.slice(0, 200)}`);
    }
}

// Each case is one message, chosen so that looking at the chat afterwards tells
// you whether the renderer is right. The first two are the regressions that
// motivated it.
const CASES = [
    ["escaping — the bug that lost all formatting",
        "*Logged.* Groceries 4820 < 6000 cap & you're 3 days ahead.\n\nRatio 1<2, trend 3200 -> 4800."],

    ["code is inert — no emphasis bleed, no unescaped angle brackets",
        "Split `3 * 4 * 5` across the month.\n\nFilter `{ amount: { $lt: 500 } }` on `user_id_1136575387`.\n\n" +
        "```js\nif (a < b && c) { save(); }\n```"],

    ["bullets, headings and emphasis",
        "## Today\n\n- Gym at 7\n- *Ship* the renderer\n- Deadline `2026-09-05`\n\n" +
        "_Nothing else is urgent._ ~~Standup~~ cancelled."],

    ["links and quoting",
        "Synced. [Open calendar](https://calendar.google.com/calendar/r?tab=rc&pli=1)\n\n" +
        "> you said you'd ship it Friday\n> and it is Friday\n\nStill open."],

    ["a long reply — must arrive as several messages, none truncated",
        Array.from({ length: 120 },
            (_, i) => `${i + 1}. Filler line proving the 4096-character split lands on a clean boundary.`
        ).join("\n")],
];

console.log(`\nRasmalai — Telegram render check`);
console.log(`  chat:  ${chatId}`);
console.log(`  token: ${token ? `…${token.slice(-6)}` : "(none — dry run)"}`);
console.log(`  mode:  ${dryRun ? "DRY RUN (nothing is sent)" : "LIVE (messages will be delivered)"}\n`);

if (!dryRun) {
    try {
        const me = await callApi("getMe", {});
        if (!me.ok) {
            console.error(`Telegram rejected the token: ${me.description}`);
            process.exit(1);
        }
        console.log(`  bot:   @${me.result.username}\n`);
    } catch (err) {
        if (err.explanation) {
            console.error(`${err.explanation}\n`);
            process.exit(2);
        }
        console.error(`Could not reach Telegram: ${err.message}\n`);
        process.exit(2);
    }
}

let sent = 0;
for (const [name, markdown] of CASES) {
    const chunks = renderForTelegram(markdown);
    console.log(`── ${name}`);
    console.log(`   ${chunks.length} message${chunks.length > 1 ? "s" : ""}, ` +
        `max ${Math.max(...chunks.map(c => c.replace(/<[^>]+>/g, "").length))} rendered chars`);

    if (dryRun) {
        chunks.forEach((c, i) => {
            const preview = c.length > 300 ? `${c.slice(0, 300)}… (+${c.length - 300} more)` : c;
            console.log(`   [${i + 1}] ${JSON.stringify(preview)}`);
        });
        console.log();
        continue;
    }

    try {
        const result = await sendMessage(chatId, markdown);
        if (result?.ok) {
            sent += chunks.length;
            console.log(`   sent ✓\n`);
        } else {
            console.log(`   FAILED: ${result?.description ?? "unknown"}\n`);
        }
    } catch (err) {
        console.log(`   FAILED: ${err.message}\n`);
    }
    // Comfortably under Telegram's ~1 msg/sec per chat.
    await new Promise((r) => setTimeout(r, 1200));
}

if (dryRun) {
    console.log("Dry run complete — nothing was sent.");
    console.log("Re-run without --dry from an unblocked network to deliver these.\n");
} else {
    console.log(`Done — ${sent} message(s) delivered to ${chatId}.`);
    console.log("Open the chat and check: no literal '#', '*' or '\\', no raw '<',");
    console.log("code spans unformatted, links tappable, long reply unbroken.\n");
}
