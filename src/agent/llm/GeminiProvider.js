import { randomUUID } from "crypto";
import { GoogleGenAI } from "@google/genai";
import { BaseLLMProvider, LLMResponse, ToolCall, makeUsage } from "./BaseLLMProvider.js";

export class GeminiProvider extends BaseLLMProvider {
    constructor({ model, apiKey } = {}) {
        super();
        const key = apiKey || process.env.GEMINI_API_KEY;
        if (!key) throw new Error("Gemini API key is required");
        this._client = new GoogleGenAI({ apiKey: key });
        if (!model) throw new Error("GeminiProvider requires a model id");
        this._model = model;
        this._name = "Gemini";
    }

    async listModels() {
        const out = [];
        // The SDK returns an async pager, not an array.
        for await (const m of await this._client.models.list()) {
            const id = (m.name || "").replace(/^models\//, "");
            if (id) out.push(id);
        }
        return out.sort();
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
                    const part = {
                        functionCall: { name: tc.name, args: tc.args, ...(tc.id && { id: tc.id }) },
                    };
                    // Gemini 3.x rejects a replayed call without its original
                    // signature: "Function call is missing a thought_signature".
                    if (tc.meta?.thoughtSignature) part.thoughtSignature = tc.meta.thoughtSignature;
                    parts.push(part);
                }
                if (parts.length) history.push({ role: "model", parts });
            } else if (msg.role === "tool_result") {
                // Gemini carries tool results as a user-role functionResponse part.
                history.push({
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                ...(msg.toolCallId && { id: msg.toolCallId }),
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

        // Read the raw parts, not response.functionCalls — that accessor drops
        // thoughtSignature, which 3.x demands back when the call is replayed.
        const parts = response.candidates?.[0]?.content?.parts || [];
        let toolCalls = parts
            .filter((p) => p.functionCall)
            .map((p) => new ToolCall(
                p.functionCall.name,
                p.functionCall.args,
                p.functionCall.id || `call_${randomUUID().slice(0, 8)}`,
                p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : null
            ));

        // Older models expose no parts array; fall back to the accessor.
        if (!toolCalls.length && response.functionCalls?.length) {
            toolCalls = response.functionCalls.map(
                (fc) => new ToolCall(fc.name, fc.args, fc.id || `call_${randomUUID().slice(0, 8)}`)
            );
        }

        return new LLMResponse({
            text: toolCalls.length ? null : response.text || null,
            toolCalls,
            rawResponse: response,
            usage: readUsage(response),
        });
    }
}

/**
 * usageMetadata -> the neutral shape.
 *
 * Gemini reports thoughts OUTSIDE candidatesTokenCount, so they are added into
 * `output` here; leaving them out would under-report the billable output of
 * every 3.x model. Google does not report a price, so billedUsd stays null.
 */
function readUsage(response) {
    const u = response?.usageMetadata;
    if (!u) return null;
    const reasoning = u.thoughtsTokenCount || 0;
    return makeUsage({
        input: u.promptTokenCount || 0,
        output: (u.candidatesTokenCount || 0) + reasoning,
        reasoning,
        cached: u.cachedContentTokenCount || 0,
        total: u.totalTokenCount ?? null,
    });
}
