/**
 * USD -> the user's own currency, for showing what a turn cost.
 *
 * WHY A STATIC TABLE. Same reasoning as pricing.js: costing happens while a
 * user is waiting for a reply, so it cannot depend on a network call. A live FX
 * lookup would add a failure mode and a few hundred milliseconds to every
 * message, to move a number that is a fraction of a rupee. The rates below were
 * read from exchangerate-api.com on RATES_AS_OF and are pinned deliberately.
 *
 * WHAT STALENESS COSTS HERE. Nothing that matters. These figures label a
 * footer, not an invoice — a rate 10% out moves "₹0.35" to "₹0.38". Refresh the
 * table when it feels old; do not add a fetch.
 *
 * The channel-neutral half of the footer lives here on purpose. A second client
 * (the planned mobile app) needs the same conversion and the same formatting
 * rules, but will render them its own way — so this file knows about money and
 * nothing about Telegram.
 */

export const RATES_AS_OF = "2026-09-04";

/** Units of the currency per 1 USD. */
const USD_RATES = {
    USD: 1,
    INR: 94.54, EUR: 0.8606, GBP: 0.7398, JPY: 156.02, AUD: 1.3897,
    CAD: 1.3793, SGD: 1.2674, AED: 3.6725, CHF: 0.8082, CNY: 6.7355,
    SEK: 9.5601, NZD: 1.7006, ZAR: 16.004, BRL: 5.0947, MXN: 16.948,
    PLN: 3.7202, TRY: 48.395, KRW: 1356.73, IDR: 17656.57, MYR: 4.0423,
    PHP: 62.541, THB: 32.942, VND: 26003.68, NGN: 1324.79, PKR: 277.36,
    BDT: 122.80, LKR: 328.09, SAR: 3.75, ILS: 3.0135, NOK: 9.2933,
    DKK: 6.4349, CZK: 20.827, HUF: 313.54, RON: 4.5237, UAH: 44.742,
    EGP: 50.939, KES: 129.37, HKD: 7.8405, TWD: 31.687,
};

/**
 * IANA zone -> ISO 4217, used only when the profile has no `currency`.
 *
 * users.currency is nullable and nothing sets it today — the row is created
 * with a timezone and little else — so without this fallback every footer would
 * read in USD for a user who thinks in rupees. An explicit profile currency
 * always wins; this is the guess, not the answer.
 */
const ZONE_CURRENCY = {
    "Asia/Kolkata": "INR", "Asia/Calcutta": "INR",
    "Asia/Karachi": "PKR", "Asia/Dhaka": "BDT", "Asia/Colombo": "LKR",
    "Asia/Dubai": "AED", "Asia/Riyadh": "SAR", "Asia/Jerusalem": "ILS",
    "Asia/Singapore": "SGD", "Asia/Tokyo": "JPY", "Asia/Seoul": "KRW",
    "Asia/Shanghai": "CNY", "Asia/Hong_Kong": "HKD", "Asia/Taipei": "TWD",
    "Asia/Jakarta": "IDR", "Asia/Kuala_Lumpur": "MYR", "Asia/Manila": "PHP",
    "Asia/Bangkok": "THB", "Asia/Ho_Chi_Minh": "VND", "Asia/Istanbul": "TRY",
    "Europe/London": "GBP", "Europe/Dublin": "EUR", "Europe/Paris": "EUR",
    "Europe/Berlin": "EUR", "Europe/Madrid": "EUR", "Europe/Rome": "EUR",
    "Europe/Amsterdam": "EUR", "Europe/Lisbon": "EUR", "Europe/Zurich": "CHF",
    "Europe/Stockholm": "SEK", "Europe/Oslo": "NOK", "Europe/Copenhagen": "DKK",
    "Europe/Warsaw": "PLN", "Europe/Prague": "CZK", "Europe/Budapest": "HUF",
    "Europe/Bucharest": "RON", "Europe/Kyiv": "UAH",
    "America/New_York": "USD", "America/Chicago": "USD", "America/Denver": "USD",
    "America/Los_Angeles": "USD", "America/Toronto": "CAD", "America/Vancouver": "CAD",
    "America/Mexico_City": "MXN", "America/Sao_Paulo": "BRL",
    "Australia/Sydney": "AUD", "Australia/Melbourne": "AUD", "Australia/Perth": "AUD",
    "Pacific/Auckland": "NZD",
    "Africa/Lagos": "NGN", "Africa/Nairobi": "KES", "Africa/Cairo": "EGP",
    "Africa/Johannesburg": "ZAR",
};

/** Zero-decimal currencies — "¥156" not "¥156.00". */
const NO_MINOR_UNIT = new Set(["JPY", "KRW", "VND", "IDR", "CLP", "ISK", "HUF"]);

/**
 * The currency to show a user, most trustworthy source first.
 * An unknown code falls through to USD rather than producing a number in a
 * currency we cannot convert to.
 */
export function resolveCurrency(profile = {}) {
    const explicit = profile?.currency?.toUpperCase?.();
    if (explicit && USD_RATES[explicit]) return explicit;

    const fromZone = ZONE_CURRENCY[profile?.timezone];
    if (fromZone && USD_RATES[fromZone]) return fromZone;

    return "USD";
}

export function convertFromUsd(usd, currency = "USD") {
    const rate = USD_RATES[currency];
    if (typeof usd !== "number" || !Number.isFinite(usd) || !rate) return null;
    return usd * rate;
}

/**
 * A turn's cost, written the way a person reads money.
 *
 * The hard part is scale. A conversation turn lands somewhere around ₹0.30, so
 * a plain 2-decimal format is right at the edge of saying nothing, and rounding
 * a real cost to "₹0.00" is worse than useless — it reads as free. So:
 *
 *   - a value that would round to zero but is not zero shows as "<₹0.01"
 *   - exactly zero shows as "free", which is the truth on every free tier and
 *     is what the whole chain currently runs on
 *   - null (no price for that model) shows as nothing at all, never as 0
 *
 * @param {number|null} usd
 * @param {{currency?: string, locale?: string}} opts
 * @returns {string|null}
 */
export function formatMoney(usd, { currency = "USD", locale } = {}) {
    if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;

    const value = convertFromUsd(usd, currency);
    if (value === null) return null;

    const digits = NO_MINOR_UNIT.has(currency) ? 0 : 2;
    const fmt = (n, min = digits, max = digits) => {
        try {
            return new Intl.NumberFormat(locale || undefined, {
                style: "currency", currency,
                minimumFractionDigits: min, maximumFractionDigits: max,
            }).format(n);
        } catch {
            // An unknown locale or currency must not break a reply.
            return `${currency} ${n.toFixed(max)}`;
        }
    };

    if (value === 0) return "free";

    const smallest = digits === 0 ? 1 : 10 ** -digits;
    if (value < smallest) return `<${fmt(smallest)}`;

    return fmt(value);
}

/** Milliseconds as seconds, which is the unit a person waiting reads in. */
export function formatDuration(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
    if (ms < 100) return "<0.1s";
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * "groq:openai/gpt-oss-120b" -> "gpt-oss-120b".
 *
 * Metrics carry the routing key, which is provider-qualified and sometimes
 * org-qualified on top. None of that means anything to the person reading a
 * footer, and ":free" is a billing tier rather than part of the name, so what
 * is left is the model itself.
 */
export function displayModel(label = "") {
    const afterProvider = String(label).includes(":")
        ? String(label).slice(String(label).indexOf(":") + 1)
        : String(label);
    return afterProvider
        .replace(/:free$/i, "")   // billing tier, not identity
        .split("/").pop()          // drop the org prefix (openai/, nvidia/)
        .trim();
}

export { USD_RATES, ZONE_CURRENCY };
