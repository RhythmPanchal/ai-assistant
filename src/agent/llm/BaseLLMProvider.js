export class ToolCall {
    constructor(name, args, id = "") {
        this.name = name;
        this.args = args;
        this.id = id;
    }
}

export class LLMResponse {
    constructor({ text = null, toolCalls = [], rawResponse = null } = {}) {
        this.text = text;
        this.toolCalls = toolCalls;
        this.rawResponse = rawResponse;
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
}
