/**
 * Hand-run:  node src/test/testProviders.js
 * Offline — global fetch is stubbed, no API keys or DB needed.
 */
import assert from "node:assert";
import { agentConfig } from "../config/agent.config.js";
import { GeminiProvider, FOREIGN_CALL_SIGNATURE } from "../agent/llm/GeminiProvider.js";
import { OpenAICompatibleProvider } from "../agent/llm/OpenAICompatibleProvider.js";
import { AnthropicProvider } from "../agent/llm/AnthropicProvider.js";
import { classifyQuotaError } from "../agent/llm/usageMeter.js";
import { ProviderManager } from "../agent/llm/createProvider.js";

const realFetch = global.fetch;
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, text) => ({ ok: false, status, text: async () => text });

const MESSAGES = [
    { role: "system", content: "you are rasmalai" },
    { role: "user", content: "log 200 on auto" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "createRecord", args: { amount: 200 } }] },
    { role: "tool_result", toolCallId: "c1", toolName: "createRecord", content: { success: true } },
    { role: "user", content: "thanks" },
];

const TOOLS = [{ name: "createRecord", description: "insert", parameters: { type: "object" } }];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── OpenAI-compatible wire format ──────────────────────────────────────────
test("formats tool_result as role:tool with tool_call_id", async () => {
    let sent;
    global.fetch = async (_url, opts) => {
        sent = JSON.parse(opts.body);
        return ok({ choices: [{ message: { content: "done" } }] });
    };
    const p = new OpenAICompatibleProvider({ name: "T", model: "m", baseURL: "https://x/v1" });
    await p.chat(MESSAGES, TOOLS);

    const toolMsg = sent.messages.find((m) => m.role === "tool");
    assert.strictEqual(toolMsg.tool_call_id, "c1");
    assert.strictEqual(toolMsg.content, JSON.stringify({ success: true }));

    const asst = sent.messages.find((m) => m.role === "assistant");
    assert.strictEqual(asst.tool_calls[0].function.arguments, JSON.stringify({ amount: 200 }));
    assert.strictEqual(sent.tools[0].function.name, "createRecord");
    assert.strictEqual(sent.tool_choice, "auto");
});

test("parses tool_calls back into ToolCall", async () => {
    global.fetch = async () =>
        ok({
            choices: [
                {
                    message: {
                        content: null,
                        tool_calls: [
                            { id: "abc", type: "function", function: { name: "createTask", arguments: '{"title":"gym"}' } },
                        ],
                    },
                },
            ],
        });
    const p = new OpenAICompatibleProvider({ name: "T", model: "m", baseURL: "https://x/v1" });
    const res = await p.chat(MESSAGES, TOOLS);
    assert.ok(res.hasToolCalls());
    assert.deepStrictEqual(res.toolCalls[0].args, { title: "gym" });
    assert.strictEqual(res.toolCalls[0].id, "abc");
});

test("surfaces HTTP status in the error message so 429s stay classifiable", async () => {
    global.fetch = async () => fail(429, "rate limit: requests per day");
    const p = new OpenAICompatibleProvider({ name: "T", model: "m", baseURL: "https://x/v1" });
    await assert.rejects(() => p.chat(MESSAGES, TOOLS), /429/);
});

// ── Gemini history split ───────────────────────────────────────────────────
test("splits system out and pops the newest turn for sendMessage", () => {
    const g = new GeminiProvider({ apiKey: "test", model: "test-model" });
    const { systemInstruction, history, latest } = g._split(MESSAGES);

    assert.strictEqual(systemInstruction, "you are rasmalai");
    assert.strictEqual(latest.parts[0].text, "thanks");
    assert.ok(!history.some((h) => h.parts?.[0]?.text === "thanks"), "newest turn must not also be in history");
    assert.strictEqual(history.find((h) => h.role === "model").parts[0].functionCall.name, "createRecord");
    assert.ok(history.some((h) => h.parts[0].functionResponse?.name === "createRecord"));
});

test("a replayed call keeps its own thought signature", () => {
    const g = new GeminiProvider({ apiKey: "test", model: "test-model" });
    const { history } = g._split([
        { role: "user", content: "spent 30" },
        { role: "assistant", content: null, toolCalls: [{ name: "createRecord", args: {}, id: "c1", meta: { thoughtSignature: "REAL-SIG" } }] },
        { role: "tool_result", toolCallId: "c1", toolName: "createRecord", content: { success: true } },
    ]);
    assert.strictEqual(history.find((h) => h.role === "model").parts[0].thoughtSignature, "REAL-SIG");
});

test("a call another provider made gets the placeholder, not nothing", () => {
    // Without it Gemini 3.x refuses the whole request, and one Cohere step after
    // a 503 locks the rest of the turn onto Cohere.
    const g = new GeminiProvider({ apiKey: "test", model: "test-model" });
    const { history } = g._split([
        { role: "user", content: "spent 30" },
        { role: "assistant", content: null, toolCalls: [{ name: "createRecord", args: {}, id: "cohere_1", meta: null }] },
        { role: "tool_result", toolCallId: "cohere_1", toolName: "createRecord", content: { success: true } },
    ]);
    assert.strictEqual(history.find((h) => h.role === "model").parts[0].thoughtSignature, FOREIGN_CALL_SIGNATURE);
    assert.strictEqual(FOREIGN_CALL_SIGNATURE, "skip_thought_signature_validator");
});

// ── Fallback policy ────────────────────────────────────────────────────────
// Swaps the `conversation` chain for a two-entry groq -> openrouter one, so
// the fallback policy can be driven with a stubbed fetch and no API keys.
function withChain(fn) {
    const savedTasks = agentConfig.llm.tasks;
    const savedRetry = agentConfig.llm.retry;
    agentConfig.llm.tasks = {
        ...savedTasks,
        conversation: {
            chain: [
                { provider: "groq", model: "groq/compound" },
                { provider: "openrouter", model: "openrouter/free" },
            ],
            maxSteps: 5,
        },
    };
    agentConfig.llm.retry = { maxAttempts: 3, backoffMs: 1 };
    return fn().finally(() => {
        agentConfig.llm.tasks = savedTasks;
        agentConfig.llm.retry = savedRetry;
    });
}

test("RPD on the primary skips retries and moves on immediately", () =>
    withChain(async () => {
        let groqCalls = 0;
        global.fetch = async (url) => {
            if (String(url).includes("groq")) {
                groqCalls++;
                return fail(429, JSON.stringify({ error: { message: "quota", quotaId: "RequestsPerDay" } }));
            }
            return ok({ choices: [{ message: { content: "from openrouter" } }] });
        };
        const res = await new ProviderManager({ groq: "k", openrouter: "k" }).chatWithFallback(MESSAGES, TOOLS);
        assert.strictEqual(res.text, "from openrouter");
        assert.strictEqual(groqCalls, 1, `daily exhaustion must not retry (got ${groqCalls} calls)`);
    }));

test("RPM on the primary does retry", () =>
    withChain(async () => {
        let groqCalls = 0;
        global.fetch = async (url) => {
            if (String(url).includes("groq")) {
                groqCalls++;
                if (groqCalls < 2) return fail(429, JSON.stringify({ error: { quotaId: "RequestsPerMinute" } }));
                return ok({ choices: [{ message: { content: "recovered" } }] });
            }
            return ok({ choices: [{ message: { content: "wrong provider" } }] });
        };
        const res = await new ProviderManager({ groq: "k" }).chatWithFallback(MESSAGES, TOOLS);
        assert.strictEqual(res.text, "recovered");
        assert.strictEqual(groqCalls, 2);
    }));

test("all providers failing reports every reason", () =>
    withChain(async () => {
        global.fetch = async () => fail(500, "boom");
        await assert.rejects(
            () => new ProviderManager({ groq: "k", openrouter: "k" }).chatWithFallback(MESSAGES, TOOLS),
            (e) =>
                /All models failed for task "conversation"/.test(e.message) &&
                // Names the exact model, not just the provider — with several
                // models per provider, "groq failed" would not say which.
                /groq\/compound/.test(e.message) &&
                /openrouter\/free/.test(e.message)
        );
    }));

// ── Anthropic wire format ──────────────────────────────────────────────────
//
// The SDK does not go through global fetch, so a stand-in client captures the
// request instead. What is pinned here is the translation: everything below is
// a 400 from the Messages API rather than a worse answer.

const ANTHROPIC_REPLY = {
    content: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
};

/** @returns {[AnthropicProvider, {body: object}]} */
function stubAnthropic(reply = ANTHROPIC_REPLY) {
    const seen = {};
    const client = {
        messages: {
            create: async (body) => {
                seen.body = body;
                if (reply instanceof Error) throw reply;
                return reply;
            },
        },
    };
    return [new AnthropicProvider({ model: "claude-haiku-4-5", client }), seen];
}

// Two calls in one assistant turn, each answered separately — the shape the
// agent loop actually produces for parallel tool use.
const PARALLEL = [
    { role: "system", content: "you are rasmalai" },
    { role: "user", content: "log 200 on auto and 50 on chai" },
    {
        role: "assistant",
        content: "On it.",
        toolCalls: [
            { id: "c1", name: "createRecord", args: { amount: 200 } },
            { id: "c2", name: "createRecord", args: { amount: 50 } },
        ],
    },
    { role: "tool_result", toolCallId: "c1", toolName: "createRecord", content: { success: true } },
    { role: "tool_result", toolCallId: "c2", toolName: "createRecord", content: { success: true } },
];

test("lifts the system prompt out of messages into a top-level parameter", async () => {
    const [p, seen] = stubAnthropic();
    await p.chat(PARALLEL, TOOLS);
    assert.strictEqual(seen.body.system, "you are rasmalai");
    assert.ok(!seen.body.messages.some((m) => m.role === "system"), "system must not stay a message");
});

test("answers every tool call of a turn in ONE user message", async () => {
    const [p, seen] = stubAnthropic();
    await p.chat(PARALLEL, TOOLS);

    // Split across two user messages the API rejects the request outright.
    const results = seen.body.messages.filter(
        (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")
    );
    assert.strictEqual(results.length, 1, "both results belong to one turn");
    assert.deepStrictEqual(results[0].content.map((b) => b.tool_use_id), ["c1", "c2"]);
    assert.strictEqual(results[0].content[0].content, JSON.stringify({ success: true }));
});

test("never merges a tool result into a real user message", async () => {
    const [p, seen] = stubAnthropic();
    await p.chat([...PARALLEL, { role: "user", content: "thanks" }], TOOLS);
    const last = seen.body.messages.at(-1);
    assert.strictEqual(last.content, "thanks", "a later user message stays its own turn");
});

test("sends assistant text and tool calls as one block list", async () => {
    const [p, seen] = stubAnthropic();
    await p.chat(PARALLEL, TOOLS);
    const asst = seen.body.messages.find((m) => m.role === "assistant");
    assert.deepStrictEqual(asst.content.map((b) => b.type), ["text", "tool_use", "tool_use"]);
    assert.deepStrictEqual(asst.content[1], { type: "tool_use", id: "c1", name: "createRecord", input: { amount: 200 } });
});

test("opens on a user turn even when the history starts with a reply", async () => {
    const [p, seen] = stubAnthropic();
    // The stale-history fallback can hand over a day that begins mid-exchange.
    await p.chat([
        { role: "system", content: "s" },
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "hi" },
    ], TOOLS);
    assert.strictEqual(seen.body.messages[0].role, "user");
});

test("maps tool parameters onto input_schema, and always sends max_tokens", async () => {
    const [p, seen] = stubAnthropic();
    await p.chat(PARALLEL, TOOLS);
    assert.strictEqual(seen.body.tools[0].name, "createRecord");
    assert.deepStrictEqual(seen.body.tools[0].input_schema, { type: "object" });
    assert.ok(!("parameters" in seen.body.tools[0]), "parameters is the OpenAI spelling");
    // Not optional on this API — a request without it is rejected.
    assert.ok(seen.body.max_tokens > 0);
});

test("counts cached tokens inside input, not beside it", async () => {
    const [p] = stubAnthropic();
    const res = await p.chat(PARALLEL, TOOLS);
    // input_tokens excludes both cache figures here, unlike every other
    // provider, so they are added back to keep `cached` a subset of `input`.
    assert.strictEqual(res.usage.input, 125);
    assert.strictEqual(res.usage.cached, 20);
    assert.strictEqual(res.usage.output, 10);
    assert.ok(res.usage.cached <= res.usage.input);
});

test("parses tool_use blocks, keeping the id the next turn has to echo", async () => {
    const [p] = stubAnthropic({
        content: [
            { type: "text", text: "looking" },
            { type: "tool_use", id: "toolu_9", name: "fetchRecord", input: { collection: "taskCalendar" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 2 },
    });
    const res = await p.chat(PARALLEL, TOOLS);
    assert.strictEqual(res.hasToolCalls(), true);
    assert.deepStrictEqual(
        [res.toolCalls[0].name, res.toolCalls[0].id, res.toolCalls[0].args],
        ["fetchRecord", "toolu_9", { collection: "taskCalendar" }]
    );
    assert.strictEqual(res.text, "looking");
});

test("keeps the HTTP status in the error so a 429 stays classifiable", async () => {
    const err = new Error("rate limited");
    err.status = 429;
    const [p] = stubAnthropic(err);
    await assert.rejects(() => p.chat(PARALLEL, TOOLS), (e) => {
        // ProviderManager reads this to tell a burst from an exhausted day.
        assert.strictEqual(classifyQuotaError(e).is429, true);
        return /429/.test(e.message);
    });
});

test("a refusal fails the entry instead of returning an empty reply", async () => {
    const [p] = stubAnthropic({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber" },
        usage: { input_tokens: 5, output_tokens: 0 },
    });
    // Returning it would send the user a blank message; throwing moves the
    // chain to the next model.
    await assert.rejects(() => p.chat(PARALLEL, TOOLS), /refusal \(cyber\)/);
});

test("a missing key fails the entry, not the whole turn", () => {
    assert.throws(() => new AnthropicProvider({ model: "claude-haiku-4-5" }), /CLAUDE_API_KEY/);
    assert.throws(() => new AnthropicProvider({ client: {} }), /requires a model id/);
});

// ── runner ─────────────────────────────────────────────────────────────────
let pass = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
        pass++;
    } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
}
global.fetch = realFetch;
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
