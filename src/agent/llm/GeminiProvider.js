import { randomUUID } from "crypto";
import { GoogleGenAI } from "@google/genai";
import { BaseLLMProvider, LLMResponse, ToolCall } from "./BaseLLMProvider.js";

export class GeminiProvider extends BaseLLMProvider {
    constructor({ model, apiKey } = {}) {
        super();
        const key = apiKey || process.env.GEMINI_API_KEY;
        if (!key) throw new Error("Gemini API key is required");
        this._client = new GoogleGenAI({ apiKey: key });
        this._model = model || "gemini-2.5-flash-lite";
        this._name = "Gemini";
    }

    /** Neutral messages -> { systemInstruction, history, latest }. */
    _split(messages) {
        let systemInstruction;
        const history = [];

        for (const msg of messages) {
            if (msg.role === "system") {
                systemInstruction = msg.content;
            } else if (msg.role === "user") {
                history.push({ role: "user", parts: [{ text: msg.content || "" }] });
            } else if (msg.role === "assistant") {
                const parts = [];
                if (msg.content) parts.push({ text: msg.content });
                for (const tc of msg.toolCalls || []) {
                    parts.push({ functionCall: { name: tc.name, args: tc.args } });
                }
                if (parts.length) history.push({ role: "model", parts });
            } else if (msg.role === "tool_result") {
                // Gemini carries tool results as a user-role functionResponse part.
                history.push({
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: msg.toolName,
                                response: { result: msg.content },
                            },
                        },
                    ],
                });
            }
        }

        // The SDK's Chat owns the window; the newest turn goes via sendMessage.
        const latest = history.pop();
        return { systemInstruction, history, latest };
    }

    async chat(messages, tools) {
        const { systemInstruction, history, latest } = this._split(messages);
        if (!latest) throw new Error("[Gemini] no sendable message");

        const config = { systemInstruction };
        if (tools?.length) config.tools = [{ functionDeclarations: tools }];

        const chatSession = this._client.chats.create({ model: this._model, config, history });

        const onlyText = latest.parts.length === 1 && latest.parts[0].text !== undefined;
        const response = await chatSession.sendMessage({
            message: onlyText ? latest.parts[0].text : latest.parts,
        });

        // Gemini returns no call ids; synthesize them for the neutral shape.
        const toolCalls = (response.functionCalls || []).map(
            (fc) => new ToolCall(fc.name, fc.args, `call_${randomUUID().slice(0, 8)}`)
        );

        return new LLMResponse({
            text: toolCalls.length ? null : response.text || null,
            toolCalls,
            rawResponse: response,
        });
    }
}
