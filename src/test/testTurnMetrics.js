/**
 * Live check that a turn reports what it actually cost.
 *
 *   node src/test/testTurnMetrics.js
 *
 * Runs ONE read-only query through the real agent loop and asserts the metrics
 * against the turn that produced them — internal consistency (the totals equal
 * the parts), agreement with the price table, and that the same figures reached
 * the chatHistory document.
 *
 * Not offline: it spends real quota and writes one chatHistory row for the test
 * user. Kept out of `npm test` for that reason.
 */

import "dotenv/config";
import assert from "node:assert";
import { runAgent } from "../agent/agent.js";
import { runWithUserContext } from "../identity/userContext.js";
import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";
import { estimateCost, PRICING_AS_OF } from "../config/pricing.js";

// The seeded test row, so a real user's history is never touched.
const USER_ID = 999999;

// Two independent reads — enough to make the loop take a tool step and come
// back, which is what puts more than one request in the metrics.
const QUERY = "What are my pending tasks, and how much have I spent this month?";

let passed = 0, failed = 0;
function check(label, fn) {
    try {
        fn();
        console.log(`PASS  ${label}`);
        passed++;
    } catch (e) {
        console.log(`FAIL  ${label}\n      ${e.message}`);
        failed++;
    }
}

console.log(`price table asOf ${PRICING_AS_OF}\n`);
console.log(`user  >> ${QUERY}\n`);

const { text, metrics: m } = await runWithUserContext(
    { userId: USER_ID, channel: "test", address: null },
    () => runAgent(USER_ID, QUERY, "telegram")
);

console.log(`agent << ${String(text).slice(0, 300)}\n`);
console.log(JSON.stringify(m, null, 2));
console.log("");

check("a reply came back", () => {
    assert.ok(typeof text === "string" && text.trim().length > 0, "empty reply");
});

check("the turn is attributed to a chain and a source", () => {
    assert.ok(m.task, "no task");
    assert.equal(m.source, "telegram");
    assert.equal(m.outcome, "ok");
});

check("at least one step and one request", () => {
    assert.ok(m.steps >= 1, `steps=${m.steps}`);
    assert.ok(m.calls >= 1, `calls=${m.calls}`);
});

check("every request is in attempts, failures included", () => {
    assert.equal(m.attempts.length, m.calls,
        `attempts=${m.attempts.length} calls=${m.calls}`);
});

check("models lists only what actually served a step", () => {
    const served = new Set(m.attempts.filter(a => a.ok).map(a => `${a.provider}:${a.model}`));
    assert.deepEqual([...m.models].sort(), [...served].sort());
});

check("tokens were reported, not defaulted to zero", () => {
    // The system instruction alone is thousands of tokens, so a zero here means
    // usage was dropped somewhere rather than genuinely being nothing.
    assert.ok(m.tokens.input > 0, `input=${m.tokens.input}`);
    assert.ok(m.tokens.output > 0, `output=${m.tokens.output}`);
});

check("token totals equal the sum of their parts", () => {
    assert.equal(m.tokens.total, m.tokens.input + m.tokens.output);
    const sum = (k) => m.attempts.reduce((a, x) => a + x[k], 0);
    assert.equal(m.tokens.input, sum("input"));
    assert.equal(m.tokens.output, sum("output"));
    assert.equal(m.tokens.reasoning, sum("reasoning"));
});

check("reasoning is inside output, cached is inside input", () => {
    assert.ok(m.tokens.reasoning <= m.tokens.output,
        `reasoning=${m.tokens.reasoning} > output=${m.tokens.output}`);
    assert.ok(m.tokens.cached <= m.tokens.input,
        `cached=${m.tokens.cached} > input=${m.tokens.input}`);
});

check("latency splits into LLM and tool time", () => {
    assert.ok(m.llmMs <= m.durationMs, `llmMs=${m.llmMs} > durationMs=${m.durationMs}`);
    assert.equal(m.toolMs, Math.max(0, m.durationMs - m.llmMs));
    assert.equal(m.llmMs, m.attempts.reduce((a, x) => a + x.latencyMs, 0));
});

check("cost agrees with the price table, recomputed independently", () => {
    let expected = 0, allPriced = true;
    for (const a of m.attempts.filter(x => x.ok)) {
        const { listUsd, priced } = estimateCost(a.provider, a.model, a);
        if (!priced) { allPriced = false; continue; }
        expected += listUsd;
    }
    assert.equal(m.cost.priced, allPriced, "priced flag disagrees");
    if (allPriced) {
        assert.ok(Math.abs(m.cost.listUsd - expected) < 1e-12,
            `listUsd=${m.cost.listUsd} recomputed=${expected}`);
    }
});

check("a free tier bills nothing while list price stays informative", () => {
    assert.equal(m.cost.billedUsd, 0, "something was actually charged");
    if (m.cost.priced) assert.ok(m.cost.listUsd > 0, "priced turn costs nothing at list");
});

const db = await getDB();
const doc = await db.collection(CHAT_HISTORY)
    .find({ userId: USER_ID }).sort({ createdAt: -1 }).limit(1).next();

check("the same figures reached the chatHistory document", () => {
    assert.ok(doc, "no chatHistory document was written");
    const saved = doc.llmConversationMetadata;
    assert.ok(saved, "document carries no llmConversationMetadata");
    assert.equal(saved.calls, m.calls);
    assert.equal(saved.steps, m.steps);
    assert.equal(saved.tokens.total, m.tokens.total);
    assert.equal(saved.cost.listUsd, m.cost.listUsd);
    assert.deepEqual(saved.models, m.models);
    assert.equal(saved.attempts.length, m.attempts.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
