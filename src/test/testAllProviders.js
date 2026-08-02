/**
 * Hand-run:  node src/test/testAllProviders.js
 *            node src/test/testAllProviders.js groq openrouter   (subset)
 *
 * ⚠️  MAKES REAL API CALLS — up to 2 per provider, against your live quota.
 *
 * Answers one question per provider: can it actually run this agent?
 * That needs BOTH plain text AND tool calling — a provider that chats fine but
 * cannot emit a tool call is useless here, since every real action the agent
 * takes is a tool call. Providers with no key configured are skipped, not
 * failed.
 */
import "dotenv/config";
import { createProvider, listProviders } from "../agent/llm/createProvider.js";
import { agentConfig } from "../config/agent.config.js";

// Deliberately tiny — this runs against a 500/day budget.
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

const keyFor = {
    gemini: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    ollama: null, // local, no key
};

const ms = (t) => `${Date.now() - t}ms`;

async function probe(name) {
    const envVar = keyFor[name];
    if (envVar && !process.env[envVar]) {
        return { name, status: "SKIP", detail: `no ${envVar} in .env` };
    }

    let provider;
    try {
        provider = createProvider(name);
    } catch (e) {
        return { name, status: "SKIP", detail: e.message };
    }

    const model = agentConfig.llm.models[name];

    // 1. Plain text
    let t = Date.now();
    let textMs;
    try {
        const res = await provider.chat(TEXT_PROMPT, []);
        textMs = ms(t);
        if (!res.text) return { name, model, status: "FAIL", detail: "returned no text" };
    } catch (e) {
        return { name, model, status: "FAIL", detail: `text: ${e.message.slice(0, 120)}` };
    }

    // 2. Tool calling — the capability the agent actually depends on
    t = Date.now();
    try {
        const res = await provider.chat(TOOL_PROMPT, [TOOL]);
        const toolMs = ms(t);
        if (!res.hasToolCalls()) {
            return { name, model, status: "PARTIAL", detail: `text ok (${textMs}) but emitted no tool call` };
        }
        const call = res.toolCalls[0];
        const ok = call.name === "logExpense" && Number(call.args?.amount) === 200;
        return {
            name, model,
            status: ok ? "OK" : "PARTIAL",
            detail: `text ${textMs}, tools ${toolMs} → ${call.name}(${JSON.stringify(call.args)})`,
        };
    } catch (e) {
        return { name, model, status: "PARTIAL", detail: `text ok, tools failed: ${e.message.slice(0, 120)}` };
    }
}

const requested = process.argv.slice(2);
const targets = requested.length ? requested : listProviders();

console.log(`Probing: ${targets.join(", ")}\n`);

const results = [];
for (const name of targets) {
    process.stdout.write(`  ${name.padEnd(12)} … `);
    const r = await probe(name);
    results.push(r);
    console.log(`${r.status.padEnd(8)} ${r.detail}`);
}

const usable = results.filter((r) => r.status === "OK");
console.log(`\n${usable.length}/${results.length} fully usable (text + tool calling)`);

if (usable.length) {
    console.log(`Usable: ${usable.map((r) => `${r.name} (${r.model})`).join(", ")}`);
}
const chain = agentConfig.llm.fallbackChain.filter((p) => usable.some((u) => u.name === p));
console.log(`Effective fallback chain right now: ${chain.join(" -> ") || "(none — agent cannot run)"}`);

process.exit(usable.length ? 0 : 1);
