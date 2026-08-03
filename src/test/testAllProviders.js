/**
 * Hand-run:  node src/test/testAllProviders.js
 *            node src/test/testAllProviders.js conversation goodNight   (subset)
 *
 * ⚠️  MAKES REAL API CALLS — 2 per unique model across the task chains.
 *
 * Probes every (provider, model) pair the config can actually reach, then
 * prints each task's chain with live status. A provider that chats but cannot
 * emit a tool call is PARTIAL, not OK — every real action this agent takes is
 * a tool call, so text-only is useless for conversation/goodNight.
 */
import "dotenv/config";
import { createProvider, resolveTaskChain } from "../agent/llm/createProvider.js";
import { agentConfig } from "../config/agent.config.js";

const TEXT_PROMPT = [
    { role: "system", content: "You are a terse assistant. Answer in one word." },
    { role: "user", content: "What is the capital of France?" },
];

const TOOL = {
    name: "logExpense",
    description: "Record a single expense the user mentions. Use for any spending.",
    parameters: {
        type: "object",
        properties: {
            amount: { type: "number", description: "Amount spent." },
            item: { type: "string", description: "What it was spent on." },
        },
        required: ["amount", "item"],
    },
};

const TOOL_PROMPT = [
    { role: "system", content: "You log the user's expenses using the tools provided." },
    { role: "user", content: "I just spent 200 rupees on an auto rickshaw." },
];

const KEY_ENV = {
    gemini: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    ollama: null,
};

const ms = (t) => `${Date.now() - t}ms`;

async function probe(provider, model) {
    const envVar = KEY_ENV[provider];
    if (envVar && !process.env[envVar]) return { status: "SKIP", detail: `no ${envVar}` };

    let p;
    try {
        p = createProvider(provider, undefined, model);
    } catch (e) {
        return { status: "SKIP", detail: e.message };
    }

    let t = Date.now(), textMs;
    try {
        const res = await p.chat(TEXT_PROMPT, []);
        textMs = ms(t);
        if (!res.text) return { status: "FAIL", detail: "no text returned" };
    } catch (e) {
        return { status: "FAIL", detail: e.message.replace(/\s+/g, " ").slice(0, 90) };
    }

    t = Date.now();
    try {
        const res = await p.chat(TOOL_PROMPT, [TOOL]);
        if (!res.hasToolCalls()) return { status: "PARTIAL", detail: `text ${textMs}, NO tool call` };
        const c = res.toolCalls[0];
        const right = c.name === "logExpense" && Number(c.args?.amount) === 200;
        return {
            status: right ? "OK" : "PARTIAL",
            detail: `text ${textMs}, tools ${ms(t)}${right ? "" : ` → odd call ${c.name}(${JSON.stringify(c.args)})`}`,
        };
    } catch (e) {
        return { status: "PARTIAL", detail: `text ok, tools failed: ${e.message.replace(/\s+/g, " ").slice(0, 70)}` };
    }
}

const requested = process.argv.slice(2);
const taskNames = requested.length ? requested : Object.keys(agentConfig.llm.tasks);

// Unique (provider, model) pairs, so a model shared by several chains is
// probed once rather than five times.
const seen = new Map();
for (const t of taskNames)
    for (const e of resolveTaskChain(t)) seen.set(`${e.provider}:${e.model}`, e);

console.log(`Probing ${seen.size} unique models across: ${taskNames.join(", ")}\n`);

const results = new Map();
for (const [key, { provider, model }] of seen) {
    process.stdout.write(`  ${key.padEnd(34)} … `);
    const r = await probe(provider, model);
    results.set(key, r);
    console.log(`${r.status.padEnd(8)} ${r.detail}`);
}

console.log("\nTASK CHAINS (live)\n");
let broken = 0;
for (const t of taskNames) {
    const entries = resolveTaskChain(t).map((e) => {
        const k = `${e.provider}:${e.model}`;
        const s = results.get(k)?.status;
        return `${s === "OK" ? "✓" : s === "SKIP" ? "·" : "✗"} ${e.model}`;
    });
    const anyOk = resolveTaskChain(t).some((e) => results.get(`${e.provider}:${e.model}`)?.status === "OK");
    if (!anyOk) broken++;
    console.log(`  ${t.padEnd(14)} ${anyOk ? "" : "[NO WORKING MODEL] "}${entries.join("   ")}`);
}

const ok = [...results.values()].filter((r) => r.status === "OK").length;
console.log(`\n${ok}/${results.size} models fully usable (text + tool calling)`);
console.log("  ✓ usable   ✗ failing   · no key configured");

process.exit(broken ? 1 : 0);
