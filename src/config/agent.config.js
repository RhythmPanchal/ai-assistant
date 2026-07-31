/**
 * Free-tier reality as of 2026-08. Gemini figures read off this project's own
 * AI Studio dashboard (aistudio.google.com/rate-limit) — Google no longer
 * publishes them, and third-party listicles are wrong:
 *
 *   RPD:  2.5 Flash 20 | 2.5 Flash-Lite 20 | 3.5 Flash 20 | 3.5 Flash-Lite 500
 *   RPM:  2.5 Flash  5 | 2.5 Flash-Lite 10 | 3.5 Flash  5 | 3.5 Flash-Lite  15
 *
 * Every "Flash" tier caps at 20 RPD. Only 3.1+/3.5 Flash-Lite gets 500.
 *
 *   Groq       - up to 14.4K RPD on small models, but 6K-15K TPM. Many small
 *                calls, never one big call. Opposite shape to Gemini.
 *   OpenRouter - 50 req/day (1000 after $10 credit). Backup only; its value is
 *                that swapping a dead free model is a model-name change.
 * Cerebras ($5 trial credits) and Mistral (pay-as-you-go) have no free API
 * tier and are deliberately absent.
 */
export const agentConfig = {
    llm: {
        defaultProvider: process.env.LLM_PROVIDER || "gemini",
        fallbackChain: ["gemini", "groq", "openrouter", "ollama"],
        models: {
            // 500 RPD vs 20 on any Flash tier — the only model that makes the
            // agent loop viable at all. 2.5-flash-lite would have gained nothing.
            gemini: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
            groq: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
            openrouter: process.env.OPENROUTER_MODEL || "openrouter/free",
            ollama: process.env.OLLAMA_MODEL || "llama3.1",
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
