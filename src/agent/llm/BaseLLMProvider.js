export class ToolCall {
    /**
     * @param {Object} [meta] opaque provider data that must be echoed back
     *        verbatim when the call is replayed (e.g. Gemini 3.x
     *        thoughtSignature). Never inspected outside its own provider.
     */
    constructor(name, args, id = "", meta = null) {
        this.name = name;
        this.args = args;
        this.id = id;
        this.meta = meta;
    }
}

/**
 * Normalized token usage for one request.
 *
 * `output` ALWAYS includes reasoning tokens, because that is what is billed;
 * `reasoning` is the informational subset of it. The providers disagree on
 * this — Gemini reports thoughts alongside candidates, OpenAI reports them
 * inside completion — so each reconciles its own dialect and callers never
 * have to know which one answered.
 *
 * `cached` is a subset of `input`, not an addition to it.
 * `billedUsd` is what the provider says it charged; null when it does not say.
 */
export function makeUsage({
    input = 0, output = 0, reasoning = 0, cached = 0, total = null, billedUsd = null,
} = {}) {
    return { input, output, reasoning, cached, total: total ?? input + output, billedUsd };
}

export class LLMResponse {
    constructor({ text = null, toolCalls = [], rawResponse = null, usage = null } = {}) {
        this.text = text;
        this.toolCalls = toolCalls;
        this.rawResponse = rawResponse;
        this.usage = usage;
    }

    hasToolCalls() {
        return this.toolCalls.length > 0;
    }
}

/**
 * Provider-agnostic contract.
 *
 * Messages use one neutral shape that every provider translates into its own
 * wire format:
 *   { role: "system"      , content }
 *   { role: "user"        , content }
 *   { role: "assistant"   , content, toolCalls[] }
 *   { role: "tool_result" , toolCallId, toolName, content }
 */
export class BaseLLMProvider {
    get name() {
        return this._name || this.constructor.name;
    }

    async chat(_messages, _tools) {
        throw new Error(`${this.constructor.name} must implement chat()`);
    }

    /** Model ids this account can actually reach. [] if unsupported. */
    async listModels() {
        return [];
    }
}
