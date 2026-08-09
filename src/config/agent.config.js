/**
 * Real free-tier limits, read off each vendor's own dashboard (scratch/docs/Models_Usage).
 *
 *   GEMINI (aistudio.google.com)          TPM    RPM   RPD
 *     gemini-3.5-flash-lite               250K    15   500   preview-generous, may tighten
 *     gemini-3.1-flash-lite               250K    15   500   separate bucket
 *     gemini-3.5-flash                    250K     5    20   strongest Flash
 *     gemini-2.5-flash                    250K     5    20
 *     gemini-2.5-flash-lite               250K    10    20
 *
 *   GROQ (console.groq.com)               TPM    TPD   RPM   RPD
 *     openai/gpt-oss-120b / -20b            8K   200K   30    1K   tools OK, thin
 *     llama-3.3-70b-versatile                                      tools OK, limits unlisted
 *     groq/compound                        70K    inf   30   250   NO TOOL CALLING
 *     qwen/qwen3.6-27b                      8K   200K   30    1K   leaks <think> into text
 *
 *   CEREBRAS (cloud.cerebras.ai)          TPM    TPD   RPM   RPD
 *     gpt-oss-120b / gemma-4-31b /
 *     zai-glm-4.7-preview                  30K     1M    5   2.4K
 *
 * WHAT IS ACTUALLY USABLE  (src/test/evalModels.js, full report in
 * src/test/eval-results.txt — one real query, all 13 ids, graded 9 ways)
 *
 *   PASS 9/9  gemini 3.5-flash, 3.5-flash-lite, 3.1-flash-lite, 2.5-flash
 *   WEAK 4/9  gemini-2.5-flash-lite — stops after the first tool call
 *   404       gemini-3.1-flash — not on this account despite the dashboard
 *   402       every Cerebras id — free tier needs purchased credits
 *   429       every Groq id — see below
 *
 * GROQ IS EXCLUDED ON TPM, NOT CAPABILITY
 * Its models do call tools correctly in isolation. But this prompt costs ~5K
 * tokens for step 1 and ~4K more for step 2, and the free tier caps at 8K
 * tokens/MINUTE: "429 TPM: Limit 8000, Used 5776". A two-step tool loop
 * cannot fit. Under a saturated org-wide window Groq also returns a
 * misleading "invalid JSON schema" 400 — the schemas are valid.
 * ~2.7K of that prompt is the 13 tool declarations, so scoping tools per task
 * is the change that would bring Groq (and its 30 RPM) back into play.
 *
 * Each MODEL has its own counter, so chaining models inside one provider
 * multiplies usable quota and survives any single allowance being cut —
 * which matters because 3.x-flash-lite's 500 RPD is promotional.
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
    OR_FREE: "openrouter/free",
    OLLAMA: "llama3.1",
};

const g = (model) => ({ provider: "gemini", model });

// Only reached when everything above is exhausted. Verified working
// (text + tool call + tool-result round trip) via src/test/tryModel.js.
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
            // Needs RPM headroom and volume — both 500-RPD buckets first.
            // Schema mistakes here land silently as bad rows, so only models
            // that scored 9/9 on the eval lead. Capacity ≈ 1070 req/day.
            conversation: {
                chain: [g(M.GEM_35_FL), g(M.GEM_31_FL), g(M.GEM_25_FL), ...LAST_RESORT],
                maxSteps: 20,
            },

            // Once a day, latency irrelevant, and after the prompt fix it needs
            // NO tool calls — pure prose reasoning, so there is no schema to
            // violate. The one task worth spending a scarce 20-RPD quality
            // bucket on. No LAST_RESORT: it runs once daily and can wait.
            goodMorning: {
                chain: [g(M.GEM_35_F), g(M.GEM_25_F), g(M.GEM_35_FL), g(M.GEM_31_FL)],
                maxSteps: 8,
            },

            // Not one call — a multi-turn extraction conversation, tool-heavy
            // and schema-critical. Strongest model first for extraction
            // fluency; a long wrap-up spills into the abundant lite buckets.
            goodNight: {
                chain: [g(M.GEM_35_F), g(M.GEM_35_FL), g(M.GEM_31_FL), ...LAST_RESORT],
                maxSteps: 20,
            },

            // Future weekly/monthly rollups: large inputs, no tools, nobody
            // waiting. Leads on the abundant 500-RPD bucket, not the scarce
            // quality one — bulk volume matters more than nuance here.
            summarize: {
                chain: [g(M.GEM_31_FL), g(M.GEM_25_FL), ...LAST_RESORT],
                maxSteps: 4,
            },

            // Future Slack ingestion: event-driven bursts, structured
            // extraction. Both 15-RPM buckets, since bursts need RPM headroom.
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
