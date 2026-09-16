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

const { runAgent, WORK_DONE_REPLY } = await import("../agent/agent.js");
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

// ── repeated writes ───────────────────────────────────────────────────────
const WRITE = { collectionName: "expenseRegister", data: { name: "coke", amount: 30, category: "Food" } };
const ok = () => new ToolResult(true, "Successfully inserted record into expenseRegister", { insertedId: "x" });
const countOf = (calls, name) => calls.filter(c => c.name === name).length;

test("an identical successful write in a later step is not run again", async () => {
    const wire = scriptModel([callTool("createRecord", WRITE, "c1"), callTool("createRecord", WRITE, "c2"), say("Logged ₹30.")]);
    const calls = stubTools(ok);
    await turn("spent 30 on a coke");
    assert.strictEqual(countOf(calls, "createRecord"), 1, "the repeat must not reach the database");
    const repeat = wire[2].find(m => m.role === "tool_result" && m.toolCallId === "c2");
    assert.match(repeat.content.message, /NOT run again/);
});

test("a turn that only repeats itself ends instead of spending the step limit", async () => {
    const wire = scriptModel([
        callTool("createRecord", WRITE, "c1"), callTool("createRecord", WRITE, "c2"),
        callTool("createRecord", WRITE, "c3"), callTool("createRecord", WRITE, "c4"), say("never reached"),
    ]);
    const calls = stubTools(ok);
    const { text } = await turn("spent 30 on a coke");
    assert.strictEqual(countOf(calls, "createRecord"), 1);
    assert.strictEqual(wire.length, 3, `the model was asked ${wire.length} times; two idle repeat steps should end the turn`);
    assert.strictEqual(text, WORK_DONE_REPLY);
});

test("a read is always run again — the fresh answer is the point", async () => {
    scriptModel([callTool("fetchRecord", { collection: "expenseRegister", filters: {} }, "r1"), callTool("fetchRecord", { collection: "expenseRegister", filters: {} }, "r2"), say("done")]);
    const calls = stubTools(() => new ToolResult(true, "Fetched 0 records", []));
    await turn();
    assert.strictEqual(countOf(calls, "fetchRecord"), 2);
});

test("identical writes in ONE step both run — two rickshaws, ₹50 each", async () => {
    scriptModel([() => new LLMResponse({ toolCalls: [new ToolCall("createRecord", WRITE, "p1"), new ToolCall("createRecord", WRITE, "p2")] }), say("Logged both.")]);
    const calls = stubTools(ok);
    await turn("two rickshaws, 50 each");
    assert.strictEqual(countOf(calls, "createRecord"), 2);
});

test("a write that failed can be retried with the same arguments", async () => {
    scriptModel([callTool("createRecord", WRITE, "f1"), callTool("createRecord", WRITE, "f2"), say("Logged.")]);
    let n = 0;
    const calls = stubTools(() => (n++ === 0 ? new ToolResult(false, "timeout") : ok()));
    await turn("spent 30 on a coke");
    assert.strictEqual(countOf(calls, "createRecord"), 2);
});

test("argument key order does not disguise a repeat", async () => {
    const reordered = { data: { category: "Food", amount: 30, name: "coke" }, collectionName: "expenseRegister" };
    scriptModel([callTool("createRecord", WRITE, "k1"), callTool("createRecord", reordered, "k2"), say("Logged.")]);
    const calls = stubTools(ok);
    await turn("spent 30 on a coke");
    assert.strictEqual(countOf(calls, "createRecord"), 1);
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
