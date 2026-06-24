import { BaseLLMProvider, LLMResponse, ToolCall } from "./BaseLLMProvider.js";

/**
 * Mistral-specific provider.
 *
 * Mistral's tool schema validation is stricter than OpenAI's — it rejects:
 *   - `type: "object"` without a `properties` field
 *   - Unknown keywords like `nullable`
 *   - Uppercase type strings (e.g. "OBJECT" instead of "object")
 *
 * This provider sanitizes the tool declarations before sending.
 */
export class MistralProvider extends BaseLLMProvider {
    constructor({ model, apiKey } = {}) {
        super();
        this._model = model || process.env.MISTRAL_MODEL || "mistral-devstral-latest";
        this._apiKey = apiKey || process.env.MISTRAL_API_KEY;
        this._baseURL = "https://api.mistral.ai/v1";
        this._name = "Mistral";
    }

    /**
     * Recursively sanitize a JSON Schema object so Mistral accepts it:
     * - Lowercase all `type` values
     * - Ensure `type: "object"` always has a `properties` key
     * - Remove unknown keywords (`nullable`, `format` on objects, etc.)
     */
    _sanitizeSchema(schema) {
        if (!schema || typeof schema !== "object") return schema;

        const out = {};

        for (const [key, val] of Object.entries(schema)) {
            // Skip Gemini-only keywords that Mistral rejects
            if (key === "nullable") continue;

            if (key === "type" && typeof val === "string") {
                out.type = val.toLowerCase();
            } else if (key === "properties" && typeof val === "object") {
                const sanitizedProps = {};
                for (const [propName, propVal] of Object.entries(val)) {
                    sanitizedProps[propName] = this._sanitizeSchema(propVal);
                }
                out.properties = sanitizedProps;
            } else if (key === "items") {
                out.items = this._sanitizeSchema(val);
            } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
                out[key] = val.map(s => this._sanitizeSchema(s));
            } else {
                out[key] = val;
            }
        }

        // Mistral requires `properties: {}` when type is object
        if (out.type === "object" && !out.properties) {
            out.properties = {};
        }

        return out;
    }

    _convertTools(tools) {
        return tools.map(t => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: this._sanitizeSchema(t.parameters)
            }
        }));
    }

    async chat(messages, tools) {
        const formattedMessages = messages.map(msg => {
            if (msg.role === "tool_result") {
                return {
                    role: "tool",
                    tool_call_id: msg.toolCallId || "call_placeholder",
                    name: msg.toolName,
                    content: typeof msg.content === "object"
                        ? JSON.stringify(msg.content)
                        : String(msg.content ?? "")
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
            return { role: msg.role, content: msg.content ?? "" };
        });

        const body = {
            model: this._model,
            messages: formattedMessages,
            temperature: 0.1,
        };

        if (tools && tools.length > 0) {
            body.tools = this._convertTools(tools);
            body.tool_choice = "auto";
        }

        const res = await fetch(`${this._baseURL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this._apiKey}`
            },
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
            for (const tc of msg.tool_calls) {
                let args = {};
                try {
                    args = typeof tc.function.arguments === "string"
                        ? JSON.parse(tc.function.arguments)
                        : tc.function.arguments || {};
                } catch (e) {
                    console.error("[MistralProvider] Failed to parse tool args:", tc.function.arguments);
                }
                toolCalls.push(new ToolCall(tc.function.name, args, tc.id));
            }
        }

        return new LLMResponse({
            text: msg.content || null,
            toolCalls,
            rawResponse: data
        });
    }
}
