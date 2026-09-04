/**
 * List prices per model, for costing a turn.
 *
 * WHY THIS IS IN THE SOURCE TREE. CLAUDE.md keeps rate limits and capability
 * data in scratch/docs/Models_Usage, which is gitignored — the runtime cannot
 * read it, and a worktree or deploy does not have it at all. Costing has to
 * happen at request time, so the table lives here instead, dated, as data with
 * no logic in it. Treat PRICING_AS_OF as an expiry date, not a comment.
 *
 * WHAT THE NUMBERS MEAN. Every model in the chains is currently on a free
 * tier, so what is actually charged is $0. These prices answer the other
 * question — what the same turn WOULD cost at published rates — which is the
 * only figure that carries information while everything is free, and the one
 * that says whether a chain is affordable before it stops being free.
 *
 * SOURCE. openrouter.ai/api/v1/models, which publishes per-token prices.
 * Keyed provider:model, because the same model costs differently per host.
 * A model with no entry is priced: false and costs null — never a silent zero.
 */

export const PRICING_AS_OF = "2026-09-04";

/** USD per MILLION tokens. `cachedIn` is optional; input rate applies without it. */
const PRICES = {
    "gemini:gemini-3.5-flash-lite": { in: 0.30, out: 2.50 },
    "gemini:gemini-3.1-flash-lite": { in: 0.25, out: 1.50 },
    "gemini:gemini-3.5-flash": { in: 1.50, out: 9.00 },
    "gemini:gemini-2.5-flash": { in: 0.30, out: 2.50 },
    "gemini:gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },

    "groq:openai/gpt-oss-120b": { in: 0.037, out: 0.17 },

    // OpenRouter's ":free" tier bills nothing. Zero here is the real price,
    // not a missing entry — which is why unknown models use null instead.
    "openrouter:nvidia/nemotron-3-super-120b-a12b:free": { in: 0, out: 0 },
    "openrouter:openai/gpt-oss-20b:free": { in: 0, out: 0 },

    // Runs on the user's own machine.
    "ollama:llama3.1": { in: 0, out: 0 },

    // Listed as cohere/command-a upstream.
    "cohere:command-a-03-2025": { in: 2.50, out: 10.00 },

    // cohere:command-a-plus-05-2026 is deliberately absent — too new to have a
    // published price found. It costs null until someone fills it in, which is
    // visible as priced:false rather than a wrong number.
};

/** The rate card for a model, or null if we have no price for it. */
export function priceFor(provider, model) {
    return PRICES[`${provider}:${model}`] || null;
}

/**
 * What one request would cost at list price.
 * Returns { listUsd, priced } — listUsd is null exactly when priced is false.
 */
export function estimateCost(provider, model, usage) {
    const p = priceFor(provider, model);
    if (!p || !usage) return { listUsd: null, priced: false };

    // `cached` is a subset of `input`, so the uncached remainder pays full rate.
    const cached = Math.min(usage.cached || 0, usage.input || 0);
    const fullInput = (usage.input || 0) - cached;
    const cachedRate = p.cachedIn ?? p.in;

    const listUsd =
        (fullInput * p.in + cached * cachedRate + (usage.output || 0) * p.out) / 1e6;

    return { listUsd, priced: true };
}
