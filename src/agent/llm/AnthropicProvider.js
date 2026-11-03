import Anthropic from "@anthropic-ai/sdk";
import { BaseLLMProvider, LLMResponse, ToolCall, makeUsage } from "./BaseLLMProvider.js";

const DEFAULT_TIMEOUT_MS = 60000;

// Required by the Messages API — there is no "unset". Big enough for a wrap-up
// reply, small enough that a runaway generation cannot hold the turn open.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Claude, through the official SDK.
 *
 * Its own class rather than another OpenAICompatibleProvider entry: the
 * Messages API disagrees with the OpenAI format in three ways, each of which
 * is a 400 rather than a degradation.
 *   - the system prompt is a top-level parameter, not a message
 *   - tool results are `tool_result` blocks inside a USER message, and every
 *     tool_use in the preceding assistant turn must be answered in ONE of them
 *   - assistant content is a block list, so text and tool calls travel together
 */
export class AnthropicProvider extends BaseLLMProvider {
    /** @param {Object} [client] stand-in for the SDK, for tests. */
    constructor({ model, apiKey, timeoutMs, maxTokens, client } = {}) {
        super();
        if (!model) throw new Error("AnthropicProvider requires a model id");
        // Thrown here rather than at the first request, so ProviderManager
        // records a missing key as this entry failing and moves to the next.
        if (!client && !apiKey) throw new Error("[Anthropic] no API key — set CLAUDE_API_KEY");

        this._name = "Anthropic";
        this._model = model;
        this._maxTokens = maxTokens || DEFAULT_MAX_TOKENS;

        // maxRetries 0 because ProviderManager owns retry and backoff. Left at
        // the SDK default of 2 the two layers multiply: 3 attempts become 9.
        this._client = client ?? new Anthropic({
            apiKey,
            timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
            maxRetries: 0,
        });
    }

    async listModels() {
        const out = [];
        for await (const m of this._client.models.list()) out.push(m.id);
        return out.sort();
    }

    /**
     * Neutral messages -> { system, messages } in the Messages API shape.
     *
     * Exported through the instance for testing; the merging of consecutive
     * tool results is the part worth pinning.
     */
    _split(messages) {
        const system = [];
        const out = [];

        for (const msg of messages) {
            if (msg.role === "system") {
                if (msg.content) system.push(String(msg.content));
                continue;
            }

            if (msg.role === "tool_result") {
                const block = {
                    type: "tool_result",
                    tool_use_id: msg.toolCallId,
                    content: asText(msg.content),
                };
                // The agent pushes one tool_result per call; Anthropic wants
                // them in a single user turn. Appended to the previous one when
                // that turn holds nothing but tool results, so a real user
                // message is never written into.
                const last = out[out.length - 1];
                const mergeable =
                    last?.role === "user" &&
                    Array.isArray(last.content) &&
                    last.content.every((b) => b.type === "tool_result");

                if (mergeable) last.content.push(block);
                else out.push({ role: "user", content: [block] });
                continue;
            }

            if (msg.role === "assistant") {
                const blocks = [];
                if (msg.content) blocks.push({ type: "text", text: String(msg.content) });
                for (const tc of msg.toolCalls ?? []) {
                    blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
                }
                // An assistant turn with no blocks at all is rejected.
                if (blocks.length) out.push({ role: "assistant", content: blocks });
                continue;
            }

            if (msg.content) out.push({ role: "user", content: String(msg.content) });
        }

        // The conversation has to open on a user turn. The history fallback can
        // hand us one that opens on an assistant reply.
        while (out.length && out[0].role !== "user") out.shift();

        return { system: system.join("\n\n") || undefined, messages: out };
    }

    async chat(messages, tools) {
        const { system, messages: history } = this._split(messages);
        if (!history.length) throw new Error("[Anthropic] no sendable message");

        const body = { model: this._model, max_tokens: this._maxTokens, messages: history };
        if (system) body.system = system;
        if (tools?.length) {
            body.tools = tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters ?? { type: "object", properties: {} },
            }));
        }

        let res;
        try {
            res = await this._client.messages.create(body);
        } catch (err) {
            // Status must survive in the message — classifyQuotaError reads it
            // to tell a per-minute burst from an exhausted daily bucket.
            throw new Error(`[Anthropic] API Error: ${err?.status ?? "no status"} ${err?.message ?? String(err)}`);
        }

        // A safety decline returns 200 with no usable content. Thrown so the
        // chain falls through to the next model instead of replying blankly.
        if (res.stop_reason === "refusal") {
            throw new Error(
                `[Anthropic] API Error: refusal (${res.stop_details?.category ?? "no category"})`
            );
        }

        const blocks = res.content ?? [];
        const toolCalls = blocks
            .filter((b) => b.type === "tool_use")
            .map((b) => new ToolCall(b.name, b.input ?? {}, b.id));
        const text = blocks
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();

        return new LLMResponse({
            text: text || null,
            toolCalls,
            rawResponse: res,
            usage: readUsage(res),
        });
    }
}

/** Tool results are objects here and strings on the wire; empty is rejected. */
function asText(content) {
    if (content === null || content === undefined) return "(no content)";
    const text = typeof content === "object" ? JSON.stringify(content) : String(content);
    return text.trim() || "(no content)";
}

/**
 * usage -> the neutral shape.
 *
 * input_tokens EXCLUDES both cache figures here, where every other provider's
 * prompt count is the whole prompt. They are added back so `input` means the
 * same thing across providers and `cached` stays a subset of it rather than an
 * addition to it. Haiku 4.5 runs without thinking, so there is no reasoning
 * count to reconcile.
 */
function readUsage(res) {
    const u = res?.usage;
    if (!u) return null;

    const cached = u.cache_read_input_tokens || 0;
    return makeUsage({
        input: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
        cached,
    });
}
