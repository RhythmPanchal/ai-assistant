/**
 * Model chains per task class.
 *
 * Provider limits, model availability and eval results are NOT restated here
 * — they go stale. See scratch/docs/Models_Usage and src/test/eval/.
 *
 * Ordering rule: abundant models first for high-frequency tasks, scarce
 * high-quality ones for tasks that run once a day. Each model has its own
 * daily counter, so listing several of one provider multiplies usable quota.
 */

const M = {
    CLAUDE_HAIKU: "claude-haiku-5-5",
    GEM_35_FL: "gemini-3.5-flash-lite",
    GEM_31_FL: "gemini-3.1-flash-lite",
    GEM_35_F: "gemini-3.5-flash",
    GEM_25_F: "gemini-2.5-flash",
    GEM_25_FL: "gemini-2.5-flash-lite",
    GROQ_120B: "openai/gpt-oss-120b",
    COH_APLUS: "command-a-plus-05-2026",
    COH_A: "command-a-03-2025",
    OR_NEMOTRON: "nvidia/nemotron-3-super-120b-a12b:free",
    OR_OSS20B: "openai/gpt-oss-20b:free",
    OLLAMA: "llama3.1",
};

const an = (model) => ({ provider: "anthropic", model });
const g = (model) => ({ provider: "gemini", model });
const co = (model) => ({ provider: "cohere", model });
const or = (model) => ({ provider: "openrouter", model });

// Leads every chain: one model that holds schemas and multi-step tool use
// across all six tasks beats a different one per task, because a prompt tuned
// against the leader is then tuned for every route. The free-tier chains stay
// behind it in their existing order, so a billing or availability problem
// degrades to what ran before instead of failing the turn.
const LEAD = [an(M.CLAUDE_HAIKU)];

// Only reached when everything above is exhausted.
const LAST_RESORT = [or(M.OR_NEMOTRON)];

export const agentConfig = {
    llm: {
        /**
         * taskClass -> ordered [{provider, model}]. Tried top to bottom; a
         * daily-quota block skips straight to the next entry.
         * Unknown task names fall back to `conversation`.
         */
        tasks: {
            // High frequency, tool-heavy, writes to Mongo, user is waiting.
            // Schema mistakes here land silently as bad rows, so only verified
            // models lead; the rest are ordered by volume behind them.
            conversation: {
                chain: [...LEAD, g(M.GEM_35_FL), g(M.GEM_31_FL), co(M.COH_APLUS), g(M.GEM_25_FL), ...LAST_RESORT],
                maxSteps: 20,
            },

            // Once a day, latency irrelevant, and after the prompt fix it needs
            // no tool calls — pure prose reasoning, nothing to violate. The one
            // task worth spending a scarce high-quality bucket on.
            goodMorning: {
                chain: [...LEAD, g(M.GEM_35_F), g(M.GEM_25_F), co(M.COH_APLUS), g(M.GEM_35_FL)],
                maxSteps: 8,
            },

            // Not one call — a multi-turn extraction conversation, tool-heavy
            // and schema-critical. A long wrap-up spills from the leader into
            // the strongest Gemini tier, then into the higher-volume ones.
            goodNight: {
                chain: [...LEAD, g(M.GEM_35_F), g(M.GEM_35_FL), g(M.GEM_31_FL), co(M.COH_APLUS), ...LAST_RESORT],
                maxSteps: 20,
            },

            // Once per user, conversational, and every answer is a notes write:
            // the extraction has to hold across a dozen turns, so the fallbacks
            // run strongest-first rather than highest-volume-first.
            onboarding: {
                chain: [...LEAD, g(M.GEM_35_F), g(M.GEM_35_FL), g(M.GEM_31_FL), co(M.COH_APLUS), ...LAST_RESORT],
                maxSteps: 10,
            },

            // Future weekly/monthly rollups: large inputs, no tools, nobody
            // waiting. Leads on volume rather than nuance.
            summarize: {
                chain: [...LEAD, g(M.GEM_31_FL), co(M.COH_A), g(M.GEM_25_FL), or(M.OR_OSS20B)],
                maxSteps: 4,
            },

            // Future Slack ingestion: event-driven bursts, structured
            // extraction. Bursts need per-minute headroom.
            ingest: {
                chain: [...LEAD, g(M.GEM_35_FL), g(M.GEM_31_FL), co(M.COH_APLUS), ...LAST_RESORT],
                maxSteps: 10,
            },
        },

        defaultTask: "conversation",

        // Used only when a chain entry supplies no model override.
        models: {
            anthropic: process.env.CLAUDE_MODEL || M.CLAUDE_HAIKU,
            gemini: process.env.GEMINI_MODEL || M.GEM_35_FL,
            groq: process.env.GROQ_MODEL || M.GROQ_120B,
            cohere: process.env.COHERE_MODEL || M.COH_APLUS,
            openrouter: process.env.OPENROUTER_MODEL || M.OR_FREE,
            ollama: process.env.OLLAMA_MODEL || M.OLLAMA,
        },

        maxSteps: 20,
        toolTimeoutMs: 15000,
        // Retrying the same key after a DAILY exhaustion can never succeed.
        retry: { maxAttempts: 3, backoffMs: 4000 },
    },
    cron: {
        goodMorning: "0 9 * * *",
        goodNight: "0 23 * * *",
    },
};

export const MODELS = M;
