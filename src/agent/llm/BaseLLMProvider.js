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
        this.toolCalls = toolCalls;  // Array of ToolCall
        this.rawResponse = rawResponse;
    }

    hasToolCalls() {
        return this.toolCalls && this.toolCalls.length > 0;
    }
}

export class BaseLLMProvider {
    /**
     * Send a chat request to the LLM.
     * @param {Array} messages List of message dicts: { role, content, toolCalls, toolResults }
     * @param {Array} tools List of tool declarations (provider-agnostic JSON Schema)
     * @returns {Promise<LLMResponse>}
     */
    async chat(messages, tools) {
        throw new Error(`${this.constructor.name} must implement chat()`);
    }

    /**
     * Optional method to fetch model list if supported
     */
    async listModels() {
        return [];
    }
}
