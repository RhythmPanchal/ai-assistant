export const agentConfig = {
    llm: {
        defaultProvider: process.env.LLM_PROVIDER || "mistral",
        fallbackChain: ["gemini", "mistral", "groq", "openrouter", "ollama", "nvidia"],
        models: {
            gemini: process.env.GEMINI_MODEL || "gemini-2.5-flash",
            mistral: process.env.MISTRAL_MODEL || "mistral-large-latest",
            groq: process.env.GROQ_MODEL || "llama3-70b-8192",
            openrouter: process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
            ollama: process.env.OLLAMA_MODEL || "llama3.1",
            nvidia: process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct",
        },
        maxSteps: 20,
        toolTimeoutMs: 15000,
    },
    cron: {
        goodMorning: "0 9 * * *", // Default 9 AM
        goodNight: "0 23 * * *",  // Default 11 PM
    }
};
