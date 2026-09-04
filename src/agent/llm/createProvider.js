import { agentConfig } from "../../config/agent.config.js";
import { GeminiProvider } from "./GeminiProvider.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import { classifyQuotaError } from "./usageMeter.js";

// Each factory takes (apiKey, model). `model` lets one provider appear several
// times in a chain under different models — the thing that makes per-model
// quota buckets addressable.
const PROVIDER_FACTORIES = {
    gemini: (apiKey, model) =>
        new GeminiProvider({
            model: model || agentConfig.llm.models.gemini,
            apiKey: apiKey || process.env.GEMINI_API_KEY,
        }),

    groq: (apiKey, model) =>
        new OpenAICompatibleProvider({
            name: "Groq",
            model: model || agentConfig.llm.models.groq,
            apiKey: apiKey || process.env.GROQ_API_KEY,
            baseURL: "https://api.groq.com/openai/v1",
        }),

    // Cohere is not OpenAI-shaped natively; /compatibility/v1 is their
    // OpenAI-compatible surface.
    cohere: (apiKey, model) =>
        new OpenAICompatibleProvider({
            name: "Cohere",
            model: model || agentConfig.llm.models.cohere,
            apiKey: apiKey || process.env.COHERE_API_KEY,
            baseURL: "https://api.cohere.ai/compatibility/v1",
        }),


    openrouter: (apiKey, model) =>
        new OpenAICompatibleProvider({
            name: "OpenRouter",
            model: model || agentConfig.llm.models.openrouter,
            apiKey: apiKey || process.env.OPENROUTER_API_KEY,
            baseURL: "https://openrouter.ai/api/v1",
            // Prices the call for us — better than any local estimate.
            reportUsage: true,
        }),

    ollama: (_apiKey, model) =>
        new OpenAICompatibleProvider({
            name: "Ollama",
            model: model || agentConfig.llm.models.ollama,
            apiKey: "ollama",
            baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
        }),
};

export function listProviders() {
    return Object.keys(PROVIDER_FACTORIES);
}

/** Build one provider. Throws if it has no usable API key. */
export function createProvider(name, apiKey, model) {
    const factory = PROVIDER_FACTORIES[name];
    if (!factory) throw new Error(`Unknown provider "${name}". Known: ${listProviders().join(", ")}`);
    return factory(apiKey, model);
}

/** Ordered [{provider, model}] for a task. Unknown tasks use the default. */
export function resolveTaskChain(task) {
    const { tasks, defaultTask } = agentConfig.llm;
    const entry = tasks[task] || tasks[defaultTask];
    if (!entry) throw new Error(`No chain configured for task "${task}" and no default task`);
    return entry.chain;
}

/** Step cap for a task, falling back to the global one. */
export function resolveMaxSteps(task) {
    const { tasks, defaultTask, maxSteps } = agentConfig.llm;
    return (tasks[task] || tasks[defaultTask])?.maxSteps ?? maxSteps;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (e) => `${e.provider}:${e.model}`;

export class ProviderManager {
    /**
     * @param {Object} userKeys keyed by PROVIDER, e.g. { gemini: "...", groq: "..." }.
     *        Keys are per provider, not per model — every Gemini model in a
     *        chain uses the same key.
     * @param {string} task     which chain to walk; see agentConfig.llm.tasks.
     */
    constructor(userKeys = {}, task = agentConfig.llm.defaultTask) {
        this.userKeys = userKeys;
        this.task = task;
    }

    /**
     * @param {Function} [opts.onAttempt] called with (provider, model) before
     *        each outbound request, so callers meter real spend per model.
     */
    async chatWithFallback(messages, tools, { onAttempt } = {}) {
        const { maxAttempts, backoffMs } = agentConfig.llm.retry;
        const failures = [];

        for (const entry of resolveTaskChain(this.task)) {
            const { provider: name, model } = entry;
            const factory = PROVIDER_FACTORIES[name];
            if (!factory) continue;

            let provider;
            try {
                provider = factory(this.userKeys[name], model);
            } catch (e) {
                // Almost always a missing API key — not worth retrying.
                failures.push(`${label(entry)}: ${e.message}`);
                continue;
            }

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    onAttempt?.(name, model);
                    const res = await provider.chat(messages, tools);
                    res.provider = name;
                    res.model = model;
                    return res;
                } catch (err) {
                    const { kind } = classifyQuotaError(err);

                    // Daily buckets are per model per day. Sleeping cannot bring
                    // one back, but the NEXT entry may be a different model with
                    // its own untouched bucket — so move on immediately.
                    if (kind === "RPD") {
                        console.warn(`[ProviderManager] ${label(entry)} daily quota exhausted — next model`);
                        failures.push(`${label(entry)}: daily quota exhausted`);
                        break;
                    }

                    const transient = kind === "RPM" || kind === "UNKNOWN_429";
                    if (transient && attempt < maxAttempts) {
                        console.warn(
                            `[ProviderManager] ${label(entry)} ${kind}, retry ${attempt}/${maxAttempts} in ${backoffMs}ms`
                        );
                        await sleep(backoffMs);
                        continue;
                    }

                    console.error(`[ProviderManager] ${label(entry)} failed:`, err.message);
                    failures.push(`${label(entry)}: ${err.message}`);
                    break;
                }
            }
        }

        throw new Error(
            `All models failed for task "${this.task}".\n  ${failures.join("\n  ")}`
        );
    }
}
