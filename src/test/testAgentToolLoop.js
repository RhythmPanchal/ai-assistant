/**
 * Hand-run:  node src/test/testAgentToolLoop.js
 *
 * The real runAgent loop, with the model and the tools stubbed. What is checked
 * is what a provider would actually put on the wire — the messages, serialised
 * — so no live model is involved and the result is deterministic.
 *
 * runAgent still reads and writes its own bookkeeping (history, profile, the
 * turn's chatHistory row, usage), so this runs in Rasmalai-eval under a
 * throwaway userId and deletes what it made.
 */
import "dotenv/config";
import assert from "node:assert";
import { ObjectId } from "mongodb";

process.env.MONGODB_DB_NAME = "Rasmalai-eval";

const { runAgent } = await import("../agent/agent.js");
const { ProviderManager } = await import("../agent/llm/createProvider.js");
const { LLMResponse, ToolCall } = await import("../agent/llm/BaseLLMProvider.js");
const { ToolResult } = await import("../agent/tools/BaseTool.js");
const { default: toolRegistry } = await import("../agent/tools/definitions/index.js");
const { runWithUserContext } = await import("../identity/userContext.js");
const { getDB } = await import("../tools/mongo/mongoClient.js");

const USER = 900040;
const db = await getDB();
if (/prod/i.test(db.databaseName)) throw new Error(`refusing to write to ${db.databaseName}`);
const cleanup = () => Promise.all(["chatHistory", "llmUsage", "activeFlows"].map(c => db.collection(c).deleteMany({ userId: USER })));

const realChat = ProviderManager.prototype.chatWithFallback;
const realExecute = toolRegistry.execute;

/**
 * Script the model: each entry is one step's response. Returns every request
 * the "provider" received, serialised the way a provider serialises it.
 */
function scriptModel(steps) {
    const wire = [];
    let i = 0;
    ProviderManager.prototype.chatWithFallback = async function (messages) {
        wire.push(JSON.parse(JSON.stringify(messages)));
        const res = steps[Math.min(i++, steps.length - 1)]();
        res.provider = "stub";
        res.model = "stub";
        return res;
    };
    return wire;
}
const callTool = (name, args, id) => () => new LLMResponse({ toolCalls: [new ToolCall(name, args, id)] });
const say = (text) => () => new LLMResponse({ text });

function stubTools(handler) {
    const calls = [];
    toolRegistry.execute = async (name, args) => { calls.push({ name, args }); return handler(name, args); };
    return calls;
}

const turn = (text = "how much did i spend today") =>
    runWithUserContext({ userId: USER, channel: "test" }, () => runAgent(USER, text, "telegram"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a stored IST-midnight date reaches the model as its own day, not UTC", async () => {
    const wire = scriptModel([callTool("fetchRecord", { collection: "expenseRegister", filters: {} }, "c1"), say("₹30 today.")]);
    stubTools(() => new ToolResult(true, "Fetched 1 records from expenseRegister.", [
        { _id: new ObjectId(), name: "coke", amount: 30, date: new Date("2026-09-16T18:30:00.000Z") },
    ]));

    await turn();

    const toolMessage = wire[1].find(m => m.role === "tool_result");
    assert.ok(toolMessage, "the second request carries the tool result");
    assert.strictEqual(toolMessage.content.data[0].date, "2026-09-17");
    assert.ok(!JSON.stringify(wire[1]).includes("2026-09-16T18:30:00.000Z"), "the UTC form must not reach the model at all");
});

let pass = 0;
try {
    await cleanup();
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`PASS  ${name}`); }
        catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
    }
} finally {
    ProviderManager.prototype.chatWithFallback = realChat;
    toolRegistry.execute = realExecute;
    await cleanup();
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
