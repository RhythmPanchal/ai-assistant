import { GoogleGenAI } from "@google/genai";
import { BaseLLMProvider, LLMResponse, ToolCall } from "./BaseLLMProvider.js";

export class GeminiProvider extends BaseLLMProvider {
    constructor({ model, apiKey } = {}) {
        super();
        const key = apiKey || process.env.GEMINI_API_KEY;
        if (!key) throw new Error("Gemini API key is required");
        this._client = new GoogleGenAI({ apiKey: key });
        this._model = model || "gemini-2.5-flash";
    }

    async chat(messages, tools) {
        let systemInstruction = undefined;

        // We separate system msg, history (all but last user turn), and the
        // final message to send.  The Gemini SDK's Chat object owns the context
        // window — we only pass the incremental new turn via sendMessage().
        const geminiHistory = [];
        let lastUserContent = null;  // will be sent via sendMessage

        for (const msg of messages) {
            if (msg.role === "system") {
                systemInstruction = msg.content;
                continue;
            }

            if (msg.role === "user") {
                // Buffer — we'll promote the last one to sendMessage below
                geminiHistory.push({ role: "user", parts: [{ text: msg.content || "" }] });

            } else if (msg.role === "assistant") {
                const parts = [];
                if (msg.content) parts.push({ text: msg.content });
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const tc of msg.toolCalls) {
                        parts.push({ functionCall: { name: tc.name, args: tc.args } });
                    }
                }
                if (parts.length > 0) {
                    geminiHistory.push({ role: "model", parts });
                }

            } else if (msg.role === "tool_result") {
                geminiHistory.push({
                    role: "user",
                    parts: [{
                        functionResponse: {
                            name: msg.toolName,
                            response: { result: msg.content }
                        }
                    }]
                });
            }
        }

        // The final entry in geminiHistory is the latest message to send.
        // Pop it off the history and pass it via sendMessage({ message: ... }).
        const latestEntry = geminiHistory.pop();

        if (!latestEntry) {
            throw new Error("[GeminiProvider] No sendable message found in messages array.");
        }

        // Extract what to actually send.
        // - For a plain user text turn:     send the string directly
        // - For function response parts:    send the parts array
        let sendArg;
        if (latestEntry.parts.length === 1 && latestEntry.parts[0].text !== undefined) {
            // Simple text — SDK accepts a plain string
            sendArg = latestEntry.parts[0].text;
        } else {
            // Function responses or multi-part — send parts array
            sendArg = latestEntry.parts;
        }

        const config = { systemInstruction };
        if (tools && tools.length > 0) {
            config.tools = [{ functionDeclarations: tools }];
        }

        try {
            const chatSession = this._client.chats.create({
                model: this._model,
                config,
                history: geminiHistory   // everything BEFORE the latest turn
            });

            // sendMessage expects { message: string | Part[] }
            const response = await chatSession.sendMessage({ message: sendArg });

            const toolCalls = [];
            let text = null;

            if (response.functionCalls && response.functionCalls.length > 0) {
                for (const fc of response.functionCalls) {
                    toolCalls.push(new ToolCall(fc.name, fc.args, "call_" + Math.random().toString(36).substr(2, 9)));
                }
            } else if (response.text) {
                text = response.text;
            }

            return new LLMResponse({ text, toolCalls, rawResponse: response });

        } catch (error) {
            console.error("[GeminiProvider] Error:", error);
            throw error;
        }
    }
}
