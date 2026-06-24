import { BaseLLMProvider, LLMResponse, ToolCall } from "./BaseLLMProvider.js";

/**
 * Generic provider for APIs compatible with OpenAI's format 
 * (Mistral, Groq, OpenRouter, Ollama, Nvidia, etc.)
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
    constructor({ model, apiKey, baseURL, name } = {}) {
        super();
        this._model = model;
        this._apiKey = apiKey;
        this._baseURL = baseURL;
        this._name = name;
    }

    async chat(messages, tools) {
        const formattedMessages = messages.map(msg => {
            if (msg.role === "tool_result") {
                return {
                    role: "tool",
                    tool_call_id: msg.toolCallId || "call_placeholder",
                    name: msg.toolName,
                    content: typeof msg.content === 'object' ? JSON.stringify(msg.content) : String(msg.content)
                };
            }
            if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
                return {
                    role: "assistant",
                    content: msg.content || null,
                    tool_calls: msg.toolCalls.map(tc => ({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: JSON.stringify(tc.args) }
                    }))
                };
            }
            return {
                role: msg.role,
                content: msg.content
            };
        });

        const body = {
            model: this._model,
            messages: formattedMessages,
        };

        if (tools && tools.length > 0) {
            body.tools = tools.map(t => ({
                type: "function",
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
            }));
            body.tool_choice = "auto";
        }

        const headers = {
            "Content-Type": "application/json"
        };
        if (this._apiKey) {
            headers["Authorization"] = `Bearer ${this._apiKey}`;
        }

        const res = await fetch(`${this._baseURL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`[${this._name}] API Error: ${res.status} ${err}`);
        }

        const data = await res.json();
        const choice = data.choices[0];
        const msg = choice.message;

        const toolCalls = [];
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            msg.tool_calls.forEach(tc => {
                let args = {};
                try {
                    args = JSON.parse(tc.function.arguments);
                } catch (e) {
                    console.error("Failed to parse tool arguments", tc.function.arguments);
                }
                toolCalls.push(new ToolCall(tc.function.name, args, tc.id));
            });
        }

        return new LLMResponse({
            text: msg.content || null,
            toolCalls: toolCalls,
            rawResponse: data
        });
    }
}
