import { agentConfig } from "../../config/agent.config.js";
import { GeminiProvider } from "./GeminiProvider.js";
import { MistralProvider } from "./MistralProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

// Factory functions for each provider
const PROVIDER_FACTORIES = {
    gemini: (apiKey) => new GeminiProvider({ 
        model: agentConfig.llm.models.gemini, 
        apiKey: apiKey || process.env.GEMINI_API_KEY 
    }),
    mistral: (apiKey) => new MistralProvider({ 
        model: agentConfig.llm.models.mistral, 
        apiKey: apiKey || process.env.MISTRAL_API_KEY
    }),
    groq: (apiKey) => new OpenAICompatibleProvider({ 
        name: "Groq",
        model: agentConfig.llm.models.groq, 
        apiKey: apiKey || process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1"
    }),
    openrouter: (apiKey) => new OpenAICompatibleProvider({ 
        name: "OpenRouter",
        model: agentConfig.llm.models.openrouter, 
        apiKey: apiKey || process.env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1"
    }),
    ollama: () => new OpenAICompatibleProvider({ 
        name: "Ollama",
        model: agentConfig.llm.models.ollama, 
        apiKey: "ollama",
        baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1"
    }),
    nvidia: (apiKey) => new OpenAICompatibleProvider({ 
        name: "Nvidia",
        model: agentConfig.llm.models.nvidia, 
        apiKey: apiKey || process.env.NVIDIA_API_KEY,
        baseURL: "https://integrate.api.nvidia.com/v1"
    }),
};

export class ProviderManager {
    /**
     * @param {Object} userKeys API keys provided by the user (e.g. { gemini: '...', mistral: '...' })
     */
    constructor(userKeys = {}) {
        this.userKeys = userKeys;
    }

    /**
     * Try providers in the fallback chain until one succeeds.
     */
    async chatWithFallback(messages, tools) {
        const chain = agentConfig.llm.fallbackChain;
        const defaultProvider = agentConfig.llm.defaultProvider;

        // Try the default provider first
        const providersToTry = [defaultProvider, ...chain.filter(p => p !== defaultProvider)];

        for (const providerName of providersToTry) {
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts) {
                attempts++;
                try {
                    const factory = PROVIDER_FACTORIES[providerName];
                    if (!factory) break;

                    const provider = factory(this.userKeys[providerName]);
                    console.log(`[ProviderManager] Attempting with ${providerName} (attempt ${attempts}/${maxAttempts})...`);
                    const response = await provider.chat(messages, tools);
                    return response; // Success
                } catch (error) {
                    const errorStr = error.message || String(error);
                    const isRateLimit = errorStr.includes("429") || 
                                        errorStr.includes("RESOURCE_EXHAUSTED") || 
                                        errorStr.includes("Rate Limit") || 
                                        errorStr.includes("rate limit") || 
                                        errorStr.includes("quota exceeded") || 
                                        errorStr.includes("Quota Exceeded") ||
                                        errorStr.includes("UNAVAILABLE") ||
                                        errorStr.includes("503") ||
                                        errorStr.includes("demand");
                    if (isRateLimit && attempts < maxAttempts) {
                        console.warn(`[ProviderManager] ${providerName} hit rate limit/demand spike. Retrying in 4 seconds...`);
                        await new Promise(resolve => setTimeout(resolve, 4000));
                        continue;
                    }
                    console.error(`[ProviderManager] ${providerName} failed:`, error.message);
                    break; // Break attempts loop and try next provider
                }
            }
        }

        throw new Error("All configured LLM providers failed.");
    }
}
