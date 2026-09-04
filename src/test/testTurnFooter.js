/**
 * Hand-run:  node src/test/testTurnFooter.js
 *
 * Guards the turn-cost footer and the money/duration formatting under it. Pure
 * — no .env, no network, no DB.
 *
 * The cases that matter are the ones where a number is misleading rather than
 * wrong: a real cost rounding to "₹0.00" reads as free, an unpriced model
 * summing to 0 reads as free, and a free tier genuinely IS free. Those three
 * have to look different from each other.
 */
import assert from "node:assert";
import {
    formatMoney, formatDuration, displayModel, resolveCurrency, convertFromUsd,
} from "../config/currency.js";
import { buildTurnFooter, MAX_FOOTER_CHARS } from "../tools/telegram/turnFooter.js";

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

// ------------------------------------------------------------------ money ---

check("a normal turn converts to the user's currency",
    formatMoney(0.0037, { currency: "INR", locale: "en-IN" }), "₹0.35");

// The important one. 0.0037 USD is a real cost that rounds to $0.00 — printing
// that would say "free" to someone who is being charged.
check("a sub-unit cost is a bound, never 0.00",
    formatMoney(0.0037, { currency: "USD", locale: "en-US" }), "<$0.01");

check("exactly zero is free, not a bound",
    formatMoney(0, { currency: "USD" }), "free");

check("no price at all is null, never 0",
    formatMoney(null, { currency: "INR" }), null);

check("undefined is null too", formatMoney(undefined, { currency: "INR" }), null);
check("NaN is null too", formatMoney(NaN, { currency: "INR" }), null);

check("zero-decimal currencies get no minor unit",
    formatMoney(1.5, { currency: "JPY", locale: "en-US" }), "¥234");

ok("an unknown currency does not throw",
    typeof formatMoney(1, { currency: "ZZZ" }) === "object" ||
    typeof formatMoney(1, { currency: "ZZZ" }) === "string");

ok("an unknown locale falls back rather than throwing",
    formatMoney(1, { currency: "INR", locale: "not-a-locale" }) !== undefined);

check("conversion uses the pinned rate", Math.round(convertFromUsd(1, "INR")), 95);
check("an unknown currency converts to null", convertFromUsd(1, "ZZZ"), null);

// --------------------------------------------------------------- currency ---

check("an explicit profile currency wins", resolveCurrency({ currency: "EUR", timezone: "Asia/Kolkata" }), "EUR");
check("lowercase profile currency is accepted", resolveCurrency({ currency: "inr" }), "INR");
check("timezone is the fallback", resolveCurrency({ timezone: "Asia/Kolkata" }), "INR");
check("legacy zone alias also maps", resolveCurrency({ timezone: "Asia/Calcutta" }), "INR");
check("an unknown zone falls back to USD", resolveCurrency({ timezone: "Mars/Base" }), "USD");
check("an empty profile falls back to USD", resolveCurrency({}), "USD");
check("a currency we cannot convert is not used", resolveCurrency({ currency: "ZZZ", timezone: "Asia/Tokyo" }), "JPY");

// --------------------------------------------------------------- duration ---

check("milliseconds are shown as seconds", formatDuration(3210), "3.2s");
check("sub-100ms is a bound", formatDuration(50), "<0.1s");
check("over a minute reads as minutes", formatDuration(72000), "1m 12s");
check("a whole number of minutes drops the seconds", formatDuration(120000), "2m");
check("a negative duration is null", formatDuration(-1), null);
check("a non-number is null", formatDuration("3s"), null);

// ----------------------------------------------------------------- models ---

check("the provider prefix is dropped", displayModel("gemini:gemini-2.5-flash"), "gemini-2.5-flash");
check("the org prefix is dropped too", displayModel("groq:openai/gpt-oss-120b"), "gpt-oss-120b");
check("the :free billing tier is not part of the name",
    displayModel("openrouter:nvidia/nemotron-3-super-120b-a12b:free"), "nemotron-3-super-120b-a12b");
check("a bare name is left alone", displayModel("llama3.1"), "llama3.1");

// ----------------------------------------------------------------- footer ---

const IN = { profile: { timezone: "Asia/Kolkata" }, locale: "en-IN" };
const base = (o = {}) => ({
    models: ["gemini:gemini-3.5-flash-lite"],
    durationMs: 3210,
    cost: { listUsd: 0.0037, priced: true },
    ...o,
});

check("a typical footer is one compact line",
    buildTurnFooter(base(), IN), "gemini-3.5-flash-lite · 3.2s · ~₹0.35");

check("a fallback cascade shows the chain, not just the winner",
    buildTurnFooter(base({ models: ["gemini:gemini-3.5-flash-lite", "groq:openai/gpt-oss-120b"] }), IN),
    "gemini-3.5-flash-lite → gpt-oss-120b · 3.2s · ~₹0.35");

check("a free-tier turn says free rather than a fake number",
    buildTurnFooter(base({ cost: { listUsd: 0, priced: true } }), IN),
    "gemini-3.5-flash-lite · 3.2s · free");

check("an unpriced model marks the total as a lower bound",
    buildTurnFooter(base({ cost: { listUsd: 0.0037, priced: false } }), IN),
    "gemini-3.5-flash-lite · 3.2s · ~₹0.35+");

check("no price at all omits cost instead of printing zero",
    buildTurnFooter(base({ cost: { listUsd: null, priced: false } }), IN),
    "gemini-3.5-flash-lite · 3.2s");

check("null metrics produce no footer", buildTurnFooter(null, IN), null);
check("empty metrics produce no footer", buildTurnFooter({}, IN), null);

ok("a sub-unit cost is not double-marked as approximate",
    !buildTurnFooter(base({ cost: { listUsd: 0.00005, priced: true } }), { profile: {} }).includes("~<"),
    buildTurnFooter(base({ cost: { listUsd: 0.00005, priced: true } }), { profile: {} }));

// The mobile constraint: this rides under a reply that is often already long.
const longChain = base({
    models: [
        "gemini:gemini-3.5-flash-lite", "gemini:gemini-3.1-flash-lite",
        "cohere:command-a-plus-05-2026", "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
    ],
});
const wide = buildTurnFooter(longChain, IN);
ok("a long chain still fits the one-line budget", wide.length <= MAX_FOOTER_CHARS, `${wide.length}: ${wide}`);
ok("a long chain keeps the cost", /₹/.test(wide), wide);
ok("a long chain keeps the duration", /3\.2s/.test(wide), wide);
ok("a long chain summarises the extra models", /\+\d/.test(wide), wide);

ok("every footer shape stays within budget",
    [base(), longChain, base({ durationMs: 725000 }), base({ cost: { listUsd: null } })]
        .map(m => buildTurnFooter(m, IN))
        .filter(Boolean)
        .every(f => f.length <= MAX_FOOTER_CHARS));

// A user in another zone gets their own currency, not the author's.
ok("a US user sees dollars", buildTurnFooter(base(), { profile: { timezone: "America/New_York" } }).includes("$"));
ok("a Japanese user sees yen", buildTurnFooter(base(), { profile: { timezone: "Asia/Tokyo" } }).includes("¥"));

// ------------------------------------------------------------------ report --

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES:\n");
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
}
console.log("Turn footer holds.\n");
