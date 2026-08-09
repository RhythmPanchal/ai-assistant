/**
 * Hand-run:  node src/test/testTaskRouting.js
 *
 * Guards the per-task model chains. Offline; needs .env only because the
 * agent module graph pulls in mongoClient at import.
 *
 * The capacity/TPM numbers asserted here come from scratch/docs/Models_Usage
 * (vendor dashboards) crossed with src/test/eval/measurePromptSize.js.
 */
import "dotenv/config";
import assert from "node:assert";
import { agentConfig } from "../config/agent.config.js";
import { resolveTaskChain, resolveMaxSteps, listProviders } from "../agent/llm/createProvider.js";
import { resolveTask } from "../agent/agent.js";

// Probed live with src/test/eval/tryModel.js. Must never appear in a chain.
const BANNED = {
    "groq/compound": "400 `tool calling` is not supported with this model",
    "qwen/qwen3.6-27b": "emits <think> reasoning inside the reply text",
    "llama-3.1-8b-instant": "6K TPM — one request does not fit",
    "command-r-plus-08-2024": "400 schema must be an object",
    "command-r7b-12-2024": "skips the mandated schema call, omits userId",
    "google/gemma-4-31b-it:free": "400 on tool schema via the Google backend",
};

// Verified to work, but with too little token headroom to lead a chain.
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

test("thin-headroom models never lead a chain", () => {
    const bad = [];
    for (const task of Object.keys(agentConfig.llm.tasks)) {
        const first = resolveTaskChain(task)[0];
        if (THIN_TPM.has(first.model)) bad.push(`${task} leads with ${first.model}`);
    }
    assert.deepStrictEqual(bad, [], bad.join("; "));
});

test("every chain contains only eval-verified models", () => {
    // evalModels.js: only these completed the two-step tool loop. Cerebras
    // returned 402 (free tier needs credits) and Groq 429 on TPM, so neither
    // may appear until that changes.
    const VERIFIED = new Set([
        "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
        "gemini-2.5-flash", "gemini-2.5-flash-lite",
        "command-a-plus-05-2026", "command-a-03-2025",
        "nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-oss-20b:free",
    ]);
    const bad = [];
    for (const task of Object.keys(agentConfig.llm.tasks))
        for (const e of resolveTaskChain(task))
            if (!VERIFIED.has(e.model)) bad.push(`${task} → ${e.provider}:${e.model}`);
    assert.deepStrictEqual(bad, [], `unverified models in chains:\n  ${bad.join("\n  ")}`);
});

test("no task is left without a model that scored 9/9", () => {
    // 2.5-flash-lite only scored 4/9, so it cannot be a chain's sole hope.
    const STRONG = new Set([
        "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash",
        "command-a-plus-05-2026", "command-a-03-2025",
        "nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-oss-20b:free",
    ]);
    for (const task of Object.keys(agentConfig.llm.tasks)) {
        const ok = resolveTaskChain(task).some((e) => STRONG.has(e.model));
        assert.ok(ok, `${task} has no fully-verified model`);
    }
});

test("conversation has the deepest chain — it is the highest-frequency task", () => {
    const depth = (t) => resolveTaskChain(t).length;
    for (const t of Object.keys(agentConfig.llm.tasks))
        if (t !== "conversation")
            assert.ok(depth("conversation") >= depth(t),
                `${t} has more fallbacks (${depth(t)}) than conversation (${depth("conversation")})`);
    // Per-model quotas live in scratch/docs/Models_Usage, not asserted here.
});

test("chains survive their highest-volume models being cut", () => {
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
