/**
 * Hand-run:  node src/test/testProviders.js
 * Offline — global fetch is stubbed, no API keys or DB needed.
 */
import assert from "node:assert";
import { agentConfig } from "../config/agent.config.js";
import { GeminiProvider } from "../agent/llm/GeminiProvider.js";
import { OpenAICompatibleProvider } from "../agent/llm/OpenAICompatibleProvider.js";
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
    const g = new GeminiProvider({ apiKey: "test" });
    const { systemInstruction, history, latest } = g._split(MESSAGES);

    assert.strictEqual(systemInstruction, "you are rasmalai");
    assert.strictEqual(latest.parts[0].text, "thanks");
    assert.ok(!history.some((h) => h.parts?.[0]?.text === "thanks"), "newest turn must not also be in history");
    assert.strictEqual(history.find((h) => h.role === "model").parts[0].functionCall.name, "createRecord");
    assert.ok(history.some((h) => h.parts[0].functionResponse?.name === "createRecord"));
});

// ── Fallback policy ────────────────────────────────────────────────────────
function withChain(fn) {
    const saved = { ...agentConfig.llm };
    agentConfig.llm.defaultProvider = "groq";
    agentConfig.llm.fallbackChain = ["groq", "openrouter"];
    agentConfig.llm.retry = { maxAttempts: 3, backoffMs: 1 };
    return fn().finally(() => Object.assign(agentConfig.llm, saved));
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
            (e) => /All configured LLM providers failed/.test(e.message) && /Groq/.test(e.message) && /OpenRouter/.test(e.message)
        );
    }));

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
