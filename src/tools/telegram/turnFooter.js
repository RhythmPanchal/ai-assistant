/**
 * The one-line "what this turn cost" footer.
 *
 * Produces PLAIN TEXT, not markup. The engine hands back metrics that know
 * nothing about any channel, this turns them into words, and the channel
 * decides how to make them quiet — Telegram italicises them in sendMessage, a
 * mobile client would use a smaller type ramp. Keeping the three apart is what
 * lets the same numbers ship to a second client without a rewrite.
 *
 * Design constraint that shapes everything here: it rides under a reply on a
 * phone. A reply is often already long, so the footer gets ONE line and a hard
 * character budget. Anything that does not fit is dropped, cheapest signal
 * first, rather than wrapped onto a second line.
 */

import { formatMoney, formatDuration, displayModel, resolveCurrency } from "../../config/currency.js";

// Roughly a line and a half on a narrow phone. Past this the footer starts
// competing with the reply, which is the failure this whole file is shaped to
// avoid.
const MAX_FOOTER_CHARS = 78;

// A middot reads as a separator without looking like punctuation in the text.
const SEP = " · ";

/**
 * Models, in the order they were actually used.
 *
 * A fallback cascade is the interesting case — "the first model failed and the
 * second answered" is the single most useful thing this footer can say — so the
 * chain is shown with an arrow rather than collapsed to whichever one replied.
 * Past two it stops being readable on a phone, so the rest become a count.
 */
function formatModels(models = [], limit = 2) {
    const names = [...new Set(models.map(displayModel).filter(Boolean))];
    if (names.length === 0) return null;
    if (names.length <= limit) return names.join(" → ");
    return `${names.slice(0, limit).join(" → ")} +${names.length - limit}`;
}

/**
 * @param {object} metrics  the summary from usageMeter.startTurn
 * @param {{profile?: object, currency?: string, locale?: string}} opts
 * @returns {string|null}   plain text, or null when there is nothing worth saying
 */
export function buildTurnFooter(metrics, { profile = null, currency, locale } = {}) {
    if (!metrics) return null;

    const code = currency || resolveCurrency(profile || {});
    const parts = [];

    const models = formatModels(metrics.models);
    if (models) parts.push(models);

    const took = formatDuration(metrics.durationMs);
    if (took) parts.push(took);

    // List price, not billed. Every model in the chain is on a free tier today,
    // so billedUsd is 0 across the board and reporting it would print "free" on
    // every message forever — true, and worth nothing. The list figure answers
    // the question actually being asked: what would this turn cost if it were
    // not free. "~" marks it as an estimate rather than a charge.
    const cost = formatMoney(metrics.cost?.listUsd, { currency: code, locale });
    if (cost) {
        // priced:false means at least one model in the turn had no entry in the
        // price table, so the total is a lower bound, not the answer.
        const bounded = metrics.cost?.priced === false ? "+" : "";
        // "<₹0.01" already reads as approximate; "~<₹0.01" reads as a typo.
        const approx = cost === "free" || cost.startsWith("<") ? "" : "~";
        parts.push(`${approx}${cost}${cost === "free" ? "" : bounded}`);
    }

    if (parts.length === 0) return null;

    let line = parts.join(SEP);
    if (line.length <= MAX_FOOTER_CHARS) return line;

    // Over budget. The model chain is both the longest part and the most
    // interesting one, so it is narrowed before it is abandoned: two names, then
    // one, then none. Duration and cost are a dozen characters between them and
    // always survive.
    const rest = models ? parts.slice(1) : parts;
    for (const limit of [1, 0]) {
        const narrowed = limit ? formatModels(metrics.models, limit) : null;
        line = (narrowed ? [narrowed, ...rest] : rest).join(SEP);
        if (line.length <= MAX_FOOTER_CHARS) return line;
    }

    return line.slice(0, MAX_FOOTER_CHARS - 1) + "…";
}

export { MAX_FOOTER_CHARS };
