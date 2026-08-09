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
 * WHY GROQ ONLY EVER APPEARS LAST
 * Every id above was probed with src/test/tryModel.js (text -> tool call ->
 * tool-result round trip). groq/compound returns 400 "`tool calling` is not
 * supported with this model" — it is a prebuilt agentic system, not a
 * function-calling model. qwen/qwen3.6-27b passes all three stages but emits
 * its "<think>" reasoning inside the text, which would reach Telegram.
 * That leaves gpt-oss-120b/20b, which do support tools but cap at 8K TPM.
 * Measured prompt weight (src/test/measurePromptSize.js) is ~4.5K tokens for
 * plain chat and ~6.3K for a night wrap-up before history, so one request
 * nearly fills the minute and 200K TPD works out to ~36 requests/day. Real,
 * but a last resort — never a primary.
 *
 * WHY CEREBRAS IS NOT IN THE CONVERSATION CHAIN
 * 5 RPM. A 6-step turn would take ~1.2 minutes of wall clock. Fine for jobs
 * nobody is waiting on, wrong for a chat reply. Its 1M TPD is the best bulk
 * budget available, so it leads on summarize.
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
const groq = (model) => ({ provider: "groq", model });
const cb = (model) => ({ provider: "cerebras", model });

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
            // Needs RPM headroom and volume — both 500-RPD buckets first, then
            // Groq's fast 30-RPM compound. Schema mistakes here land silently
            // as bad rows, so no 8K-TPM model gets near this path.
            // Capacity: 500 + 500 + 250 + 20 ≈ 1270 req/day.
            conversation: {
                chain: [g(M.GEM_35_FL), g(M.GEM_31_FL), g(M.GEM_25_FL), ...LAST_RESORT, groq(M.GROQ_120B)],
                maxSteps: 20,
            },

            // Once a day, latency irrelevant, and after the prompt fix it needs
            // NO tool calls — pure prose reasoning, so there is no schema to
            // violate. The one task worth spending a scarce 20-RPD quality
            // bucket on, with a 120B model behind it.
            goodMorning: {
                chain: [g(M.GEM_35_F), cb(M.CB_120B), g(M.GEM_25_F), g(M.GEM_35_FL)],
                maxSteps: 8,
            },

            // Not one call — a multi-turn extraction conversation, tool-heavy
            // and schema-critical. Strongest model first for extraction
            // fluency; a long wrap-up spills into the abundant lite buckets.
            goodNight: {
                chain: [g(M.GEM_35_F), g(M.GEM_35_FL), g(M.GEM_31_FL), ...LAST_RESORT, groq(M.GROQ_120B)],
                maxSteps: 20,
            },

            // Future weekly/monthly rollups: large inputs, no tools, nobody
            // waiting. Cerebras leads purely on its 1M/day token budget.
            summarize: {
                chain: [cb(M.CB_120B), cb(M.CB_GLM), g(M.GEM_31_FL), groq(M.GROQ_120B)],
                maxSteps: 4,
            },

            // Future Slack ingestion: event-driven bursts, structured
            // extraction. Groq's 30 RPM absorbs bursts the 5-RPM tiers cannot.
            ingest: {
                chain: [g(M.GEM_35_FL), cb(M.CB_120B), ...LAST_RESORT, groq(M.GROQ_120B)],
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
