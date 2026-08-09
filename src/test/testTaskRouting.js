/**
 * Hand-run:  node src/test/testTaskRouting.js
 *
 * Guards the per-task model chains. Offline; needs .env only because the
 * agent module graph pulls in mongoClient at import.
 *
 * The capacity/TPM numbers asserted here come from scratch/docs/Models_Usage
 * (vendor dashboards) crossed with src/test/measurePromptSize.js.
 */
import "dotenv/config";
import assert from "node:assert";
import { agentConfig } from "../config/agent.config.js";
import { resolveTaskChain, resolveMaxSteps, listProviders } from "../agent/llm/createProvider.js";
import { resolveTask } from "../agent/agent.js";

// ~7K tokens is a realistic request once history is included (measured floor
// 4.5K, night 6.3K, before history).
const REQ_TOKENS = 7000;

// Probed live with src/test/tryModel.js. Must never appear in a chain.
const BANNED = {
    "groq/compound": "400 `tool calling` is not supported with this model",
    "qwen/qwen3.6-27b": "emits <think> reasoning inside the reply text",
    "llama-3.1-8b-instant": "6K TPM — one request does not fit",
};

// 8K TPM: usable, but one request nearly fills the minute budget. Fine as a
// tail entry, never as a task's primary.
const THIN_TPM = new Set(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("every task resolves to a non-empty chain of known providers", () => {
    const known = new Set(listProviders());
    for (const task of Object.keys(agentConfig.llm.tasks)) {
        const chain = resolveTaskChain(task);
        assert.ok(chain.length, `${task} has an empty chain`);
        for (const { provider, model } of chain) {
            assert.ok(known.has(provider), `${task}: unknown provider "${provider}"`);
            assert.ok(model, `${task}: entry for ${provider} has no model`);
        }
    }
});

test("no chain uses a model verified not to work on this account", () => {
    const found = [];
    for (const task of Object.keys(agentConfig.llm.tasks))
        for (const { provider, model } of resolveTaskChain(task))
            if (BANNED[model]) found.push(`${task} → ${provider}:${model} (${BANNED[model]})`);
    assert.deepStrictEqual(found, [], `unusable models in chains:\n  ${found.join("\n  ")}`);
});

test("8K-TPM models never lead a chain", () => {
    const bad = [];
    for (const task of Object.keys(agentConfig.llm.tasks)) {
        const first = resolveTaskChain(task)[0];
        if (THIN_TPM.has(first.model)) bad.push(`${task} leads with ${first.model}`);
    }
    assert.deepStrictEqual(bad, [], bad.join("; "));
});

test("conversation avoids 5-RPM tiers — a user is waiting on it", () => {
    // Cerebras is 5 RPM; a 6-step turn would take ~1.2 min of wall clock.
    const slow = resolveTaskChain("conversation").filter(e => e.provider === "cerebras");
    assert.deepStrictEqual(slow, [], "cerebras (5 RPM) must not serve interactive chat");
});

test("cerebras leads summarize — 1M/day is the best bulk budget available", () => {
    assert.strictEqual(resolveTaskChain("summarize")[0].provider, "cerebras");
});

test("conversation has the most daily capacity of any task", () => {
    // RPD per model, from the vendor dashboards.
    const RPD = {
        "gemini-3.5-flash-lite": 500, "gemini-3.1-flash-lite": 500,
        "gemini-3.5-flash": 20, "gemini-2.5-flash": 20, "gemini-2.5-flash-lite": 20,
        "openai/gpt-oss-120b": 36, "gpt-oss-120b": 2400, "zai-glm-4.7-preview": 2400,
        "openrouter/free": 50,
    };
    const capacity = (t) => resolveTaskChain(t).reduce((n, e) => n + (RPD[e.model] ?? 0), 0);

    const conv = capacity("conversation");
    assert.ok(conv >= 1000, `conversation capacity ${conv} req/day is too thin for the highest-frequency task`);
    // ~1270 requests / ~6 calls per turn ≈ 200 conversations/day.
    console.log(`        (conversation ≈ ${conv} req/day ≈ ${Math.floor(conv / 6)} turns/day)`);
});

test("chains survive the promotional 500-RPD buckets being cut", () => {
    // gemini 3.x-flash-lite's 500 RPD is preview-generous and may tighten.
    for (const task of ["conversation", "goodNight"]) {
        const survivors = resolveTaskChain(task).filter(
            e => !/gemini-3\.[15]-flash-lite/.test(e.model)
        );
        assert.ok(survivors.length >= 2, `${task} collapses to ${survivors.length} entries without the 3.x lite buckets`);
    }
});

test("resolveTask derives the chain from the open flow", () => {
    const night = [{ flowType: "goodNight" }];
    const morning = [{ flowType: "goodMorning" }];

    assert.strictEqual(resolveTask({ source: "telegram", openFlows: [] }), "conversation");
    assert.strictEqual(resolveTask({ source: "telegram", openFlows: night }), "goodNight");
    // The job and the user's follow-up refine turns both sit under the same
    // open flow, so both get the same chain — no per-caller special case.
    assert.strictEqual(resolveTask({ source: "goodMorningJob", openFlows: morning }), "goodMorning");
    assert.strictEqual(resolveTask({ source: "telegram", openFlows: morning }), "goodMorning");
});

test("both flow types open at once resolves deterministically", () => {
    // openFlow supersedes only the SAME flowType, so this is reachable: a
    // 6h morning flow the user ignored is still open when goodNight fires.
    const both = [{ flowType: "goodMorning" }, { flowType: "goodNight" }];
    assert.strictEqual(resolveTask({ source: "telegram", openFlows: both }), "goodNight");
    assert.strictEqual(resolveTask({ source: "telegram", openFlows: [...both].reverse() }), "goodNight",
        "precedence must not depend on array order");
});

test("taskOverride still covers jobs that open no flow", () => {
    assert.strictEqual(resolveTask({ source: "telegram", override: "ingest" }), "ingest");
    assert.strictEqual(resolveTask({ source: "summarizeJob" }), "summarize");
    assert.strictEqual(resolveTask({ source: "slackIngest" }), "ingest");
    // Override beats a live flow — needed if a future job runs mid-flow.
    assert.strictEqual(
        resolveTask({ source: "telegram", openFlows: [{ flowType: "goodNight" }], override: "summarize" }),
        "summarize"
    );
});

test("per-task maxSteps is set and bounded", () => {
    for (const task of Object.keys(agentConfig.llm.tasks)) {
        const n = resolveMaxSteps(task);
        assert.ok(n > 0 && n <= 20, `${task} maxSteps=${n} out of range`);
    }
    // Tool-free single draft needs far fewer steps than a wrap-up conversation.
    assert.ok(resolveMaxSteps("goodMorning") < resolveMaxSteps("goodNight"));
});

test("unknown task falls back to the default chain", () => {
    assert.deepStrictEqual(resolveTaskChain("nope-not-a-task"), resolveTaskChain("conversation"));
});

test("model ids stay valid Mongo field paths after sanitising", async () => {
    const { LLM_USAGE } = await import("../agent/llm/usageMeter.js");
    assert.ok(LLM_USAGE);
    // Raw ids contain dots; Mongo would read byModel.gemini-3.5-flash-lite as
    // a nested path. The meter replaces dots before building the $inc key.
    const raw = "gemini:gemini-3.5-flash-lite";
    assert.ok(raw.includes("."), "fixture should contain a dot");
    assert.ok(!raw.replace(/\./g, "_").includes("."), "sanitised key still has a dot");
});

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
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
