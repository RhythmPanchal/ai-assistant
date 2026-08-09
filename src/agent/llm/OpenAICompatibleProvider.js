import { BaseLLMProvider, LLMResponse, ToolCall } from "./BaseLLMProvider.js";

const DEFAULT_TIMEOUT_MS = 60000;

/** Groq, OpenRouter, Ollama, NVIDIA — anything speaking the OpenAI wire format. */
export class OpenAICompatibleProvider extends BaseLLMProvider {
    constructor({ model, apiKey, baseURL, name, timeoutMs } = {}) {
        super();
        if (!baseURL) throw new Error(`[${name}] baseURL is required`);
        this._model = model;
        this._apiKey = apiKey;
        this._baseURL = baseURL.replace(/\/$/, "");
        this._name = name || "OpenAICompatible";
        this._timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    }

    async listModels() {
        const headers = this._apiKey ? { Authorization: `Bearer ${this._apiKey}` } : {};
        const res = await fetch(`${this._baseURL}/models`, {
            headers,
            signal: AbortSignal.timeout(this._timeoutMs),
        });
        if (!res.ok) throw new Error(`[${this._name}] /models ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
    }

    _formatMessages(messages) {
        return messages.map((msg) => {
            if (msg.role === "tool_result") {
                return {
                    role: "tool",
                    tool_call_id: msg.toolCallId,
                    name: msg.toolName,
                    content:
                        typeof msg.content === "object"
                            ? JSON.stringify(msg.content)
                            : String(msg.content),
                };
            }
            if (msg.role === "assistant" && msg.toolCalls?.length) {
                return {
                    role: "assistant",
                    content: msg.content || null,
                    tool_calls: msg.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                    })),
                };
            }
            return { role: msg.role, content: msg.content };
        });
    }

    async chat(messages, tools) {
        const body = {
            model: this._model,
            messages: this._formatMessages(messages),
        };

        if (tools?.length) {
            body.tools = tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
            }));
            body.tool_choice = "auto";
        }

        const headers = { "Content-Type": "application/json" };
        if (this._apiKey) headers.Authorization = `Bearer ${this._apiKey}`;

        // Without a timeout a stalled provider holds the whole agent turn open.
        const res = await fetch(`${this._baseURL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this._timeoutMs),
        });

        if (!res.ok) {
            // Status must survive in the message — classifyQuotaError reads it.
            throw new Error(`[${this._name}] API Error: ${res.status} ${await res.text()}`);
        }

        const data = await res.json();
        const msg = data.choices?.[0]?.message;
        if (!msg) throw new Error(`[${this._name}] malformed response: no choices[0].message`);

        const toolCalls = (msg.tool_calls || []).map((tc) => {
            let args = {};
            try {
                args = JSON.parse(tc.function.arguments);
            } catch {
                console.error(`[${this._name}] unparseable tool args:`, tc.function.arguments);
            }
            return new ToolCall(tc.function.name, args, tc.id);
        });

        return new LLMResponse({ text: msg.content || null, toolCalls, rawResponse: data });
    }
}
