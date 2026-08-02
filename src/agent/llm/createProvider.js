import { agentConfig } from "../../config/agent.config.js";
import { GeminiProvider } from "./GeminiProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import { classifyQuotaError } from "./usageMeter.js";

const PROVIDER_FACTORIES = {
    gemini: (apiKey) =>
        new GeminiProvider({
            model: agentConfig.llm.models.gemini,
            apiKey: apiKey || process.env.GEMINI_API_KEY,
        }),

    groq: (apiKey) =>
        new OpenAICompatibleProvider({
            name: "Groq",
            model: agentConfig.llm.models.groq,
            apiKey: apiKey || process.env.GROQ_API_KEY,
            baseURL: "https://api.groq.com/openai/v1",
        }),

    openrouter: (apiKey) =>
        new OpenAICompatibleProvider({
            name: "OpenRouter",
            model: agentConfig.llm.models.openrouter,
            apiKey: apiKey || process.env.OPENROUTER_API_KEY,
            baseURL: "https://openrouter.ai/api/v1",
        }),

    ollama: () =>
        new OpenAICompatibleProvider({
            name: "Ollama",
            model: agentConfig.llm.models.ollama,
            apiKey: "ollama",
            baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
        }),
};

export function listProviders() {
    return Object.keys(PROVIDER_FACTORIES);
}

/** Build a single provider by name. Throws if it has no usable API key. */
export function createProvider(name, apiKey) {
    const factory = PROVIDER_FACTORIES[name];
    if (!factory) throw new Error(`Unknown provider "${name}". Known: ${listProviders().join(", ")}`);
    return factory(apiKey);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProviderManager {
    /** @param {Object} userKeys e.g. { gemini: "...", groq: "..." } */
    constructor(userKeys = {}) {
        this.userKeys = userKeys;
    }

    _order() {
        const { defaultProvider, fallbackChain } = agentConfig.llm;
        return [defaultProvider, ...fallbackChain.filter((p) => p !== defaultProvider)];
    }

    /**
     * @param {Object}   [opts]
     * @param {Function} [opts.onAttempt] called with the provider name before
     *        every outbound request, so callers can meter real quota spend
     *        rather than agent steps.
     */
    async chatWithFallback(messages, tools, { onAttempt } = {}) {
        const { maxAttempts, backoffMs } = agentConfig.llm.retry;
        const failures = [];

        for (const name of this._order()) {
            const factory = PROVIDER_FACTORIES[name];
            if (!factory) continue;

            let provider;
            try {
                provider = factory(this.userKeys[name]);
            } catch (e) {
                // Almost always a missing API key — not worth retrying.
                failures.push(`${name}: ${e.message}`);
                continue;
            }

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    onAttempt?.(name);
                    const res = await provider.chat(messages, tools);
                    res.provider = name;
                    return res;
                } catch (err) {
                    const { kind } = classifyQuotaError(err);

                    // The daily bucket is per key and per day. Sleeping cannot
                    // bring it back, so drop to the next provider immediately.
                    if (kind === "RPD") {
                        console.warn(`[ProviderManager] ${name} daily quota exhausted — next provider`);
                        failures.push(`${name}: daily quota exhausted`);
                        break;
                    }

                    const transient = kind === "RPM" || kind === "UNKNOWN_429";
                    if (transient && attempt < maxAttempts) {
                        console.warn(
                            `[ProviderManager] ${name} ${kind}, retry ${attempt}/${maxAttempts} in ${backoffMs}ms`
                        );
                        await sleep(backoffMs);
                        continue;
                    }

                    console.error(`[ProviderManager] ${name} failed:`, err.message);
                    failures.push(`${name}: ${err.message}`);
                    break;
                }
            }
        }

        throw new Error(`All configured LLM providers failed.\n  ${failures.join("\n  ")}`);
    }
}
