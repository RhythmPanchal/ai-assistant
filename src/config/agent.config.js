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
    GEM_35_FL: "gemini-3.5-flash-lite",
    GEM_31_FL: "gemini-3.1-flash-lite",
    GEM_35_F: "gemini-3.5-flash",
    GEM_25_F: "gemini-2.5-flash",
    GEM_25_FL: "gemini-2.5-flash-lite",
    GROQ_120B: "openai/gpt-oss-120b",
    CB_120B: "gpt-oss-120b",
    CB_GLM: "zai-glm-4.7-preview",
    COHERE: "command-a-03-2025",
    OR_FREE: "openrouter/free",
    OLLAMA: "llama3.1",
};

const g = (model) => ({ provider: "gemini", model });

// Only reached when everything above is exhausted.
const LAST_RESORT = [{ provider: "openrouter", model: M.OR_FREE }];

export const agentConfig = {
    llm: {
        /**
         * taskClass -> ordered [{provider, model}]. Tried top to bottom; a
         * daily-quota block skips straight to the next entry.
         * Unknown task names fall back to `conversation`.
         */
        tasks: {
            // High frequency, tool-heavy, writes to Mongo, user is waiting.
            // Needs the highest-volume models first. Schema mistakes here land
            // silently as bad rows, so only verified models lead.
            conversation: {
                chain: [g(M.GEM_35_FL), g(M.GEM_31_FL), g(M.GEM_25_FL), ...LAST_RESORT],
                maxSteps: 20,
            },

            // Once a day, latency irrelevant, and after the prompt fix it needs
            // no tool calls — pure prose reasoning, nothing to violate. The one
            // task worth spending a scarce high-quality bucket on.
            goodMorning: {
                chain: [g(M.GEM_35_F), g(M.GEM_25_F), g(M.GEM_35_FL), g(M.GEM_31_FL)],
                maxSteps: 8,
            },

            // Not one call — a multi-turn extraction conversation, tool-heavy
            // and schema-critical. Strongest model first for extraction
            // fluency; a long wrap-up spills into the higher-volume models.
            goodNight: {
                chain: [g(M.GEM_35_F), g(M.GEM_35_FL), g(M.GEM_31_FL), ...LAST_RESORT],
                maxSteps: 20,
            },

            // Future weekly/monthly rollups: large inputs, no tools, nobody
            // waiting. Leads on volume rather than nuance.
            summarize: {
                chain: [g(M.GEM_31_FL), g(M.GEM_25_FL), ...LAST_RESORT],
                maxSteps: 4,
            },

            // Future Slack ingestion: event-driven bursts, structured
            // extraction. Bursts need per-minute headroom.
            ingest: {
                chain: [g(M.GEM_35_FL), g(M.GEM_31_FL), ...LAST_RESORT],
                maxSteps: 10,
            },
        },

        defaultTask: "conversation",

        // Used only when a chain entry supplies no model override.
        models: {
            gemini: process.env.GEMINI_MODEL || M.GEM_35_FL,
            groq: process.env.GROQ_MODEL || M.GROQ_120B,
            cerebras: process.env.CEREBRAS_MODEL || M.CB_120B,
            cohere: process.env.COHERE_MODEL || M.COHERE,
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
