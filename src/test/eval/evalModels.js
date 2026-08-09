/**
 * Model eval — a scenario suite, run against one model or many.
 *
 *   npm run eval                              every model in the roster
 *   npm run eval -- gemini                    one provider
 *   npm run eval -- gemini:gemini-3.5-flash-lite
 *   npm run eval -- gemini:gemini-3.5-flash-lite read log-clear
 *
 * Writes src/test/eval/eval-results.txt.
 *
 * ⚠️  REAL API CALLS. Roughly 2-4 per scenario per model.
 *
 * REAL system instruction and REAL registry tool declarations, so prompt
 * weight matches production. Tool EXECUTION is stubbed (see scenarios.js) so
 * grading is deterministic and 13 models do not write junk rows into Mongo.
 */
import "dotenv/config";
import fs from "fs";
import { createProvider } from "../../agent/llm/createProvider.js";
import { buildSystemInstruction } from "../../agent/instruction.js";
import toolRegistry from "../../agent/tools/definitions/index.js";
import { SCENARIOS } from "./scenarios.js";

const MODELS = [
    ["gemini", "gemini-3.5-flash"], ["gemini", "gemini-3.5-flash-lite"],
    ["gemini", "gemini-3.1-flash-lite"],
    ["gemini", "gemini-2.5-flash"], ["gemini", "gemini-2.5-flash-lite"],
    ["cohere", "command-a-plus-05-2026"], ["cohere", "command-a-03-2025"],
    ["openrouter", "nvidia/nemotron-3-super-120b-a12b:free"],
];

const MAX_STEPS = 6;
// TPM windows are per organisation, so back-to-back runs on one provider can
// 429 for reasons unrelated to the model.
const PACE_SEC = { groq: 70, cohere: 5, gemini: 3, openrouter: 5, ollama: 0 };
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const tools = toolRegistry.getToolDeclarations();
// --order lets a section arrangement be compared rather than assumed.
const orderArg = process.argv.find((a) => a.startsWith("--order="));
const ORDER = orderArg ? orderArg.split("=")[1].split(",") : undefined;
const systemInstruction = buildSystemInstruction([], ORDER);

async function runScenario(providerName, model, scenario) {
    const started = Date.now();
    const messages = [
        { role: "system", content: systemInstruction },
        { role: "user", content: scenario.query },
    ];
    const trace = [];
    let text = null, error = null, steps = 0;

    let provider;
    try {
        provider = createProvider(providerName, undefined, model);
    } catch (e) {
        return { trace, text, error: e.message, steps, ms: 0 };
    }

    while (steps < MAX_STEPS) {
        steps++;
        let res;
        try {
            res = await provider.chat(messages, tools);
        } catch (e) {
            error = e.message.replace(/\s+/g, " ").slice(0, 200);
            break;
        }
        if (!res.hasToolCalls()) { text = res.text || ""; break; }

        messages.push({ role: "assistant", content: res.text || null, toolCalls: res.toolCalls });
        for (const tc of res.toolCalls) {
            const stub = scenario.stubs[tc.name];
            const data = stub ? stub(tc.args) : { error: `Unknown tool "${tc.name}"` };
            trace.push({ name: tc.name, args: tc.args, known: Boolean(stub) });
            messages.push({
                role: "tool_result", toolCallId: tc.id, toolName: tc.name,
                content: { success: Boolean(stub), message: stub ? "ok" : "unknown tool", data },
            });
        }
    }
    return { trace, text, error, steps, ms: Date.now() - started };
}

// ── run ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--order="));
const modelArg = argv.find((a) => a.includes(":") || MODELS.some(([p]) => p === a));
const scenarioArgs = argv.filter((a) => a !== modelArg);

const targets = MODELS.filter(([p, m]) => !modelArg || p === modelArg || `${p}:${m}` === modelArg);
const scenarios = SCENARIOS.filter((s) => !scenarioArgs.length || scenarioArgs.includes(s.id));

console.log(`Eval: ${targets.length} model(s) x ${scenarios.length} scenario(s)\n`);

const results = [];
for (let i = 0; i < targets.length; i++) {
    const [p, m] = targets[i];
    console.log(`  ${p}:${m}`);
    for (const sc of scenarios) {
        const r = await runScenario(p, m, sc);
        const checks = r.error ? {} : sc.grade(r.trace, r.text);
        const passed = Object.values(checks).filter(Boolean).length;
        const total = Object.keys(checks).length || 1;
        results.push({ provider: p, model: m, scenario: sc, ...r, checks, passed, total });
        const flag = r.error ? "ERR " : passed === total ? "PASS" : "FAIL";
        console.log(`    ${flag} ${sc.id.padEnd(22)} ${passed}/${total}  ${r.error ? r.error.slice(0, 50) : r.trace.map((t) => t.name).join(" → ") || "no tools"}`);
    }
    if (i < targets.length - 1) await sleep(PACE_SEC[p] ?? 5);
}

// ── report ─────────────────────────────────────────────────────────────────
const L = [];
const line = (s = "") => L.push(s);
const rule = (c = "─") => line(c.repeat(78));

line("RASMALAI — MODEL EVAL");
rule("═");
line(`Generated : ${new Date().toISOString()}`);
line(`Prompt    : real system instruction + all ${tools.length} registry tool declarations`);
line(`Execution : STUBBED — deterministic grading, nothing written to Mongo`);
line();

line("SCENARIOS");
rule("═");
for (const s of SCENARIOS) {
    line();
    line(`[${s.id}]  user says: "${s.query}"`);
    line("  a correct agent:");
    s.expected.forEach((e) => line(`    - ${e}`));
}
line();

line("SUMMARY");
rule("═");
const byModel = new Map();
for (const r of results) {
    const k = `${r.provider}:${r.model}`;
    if (!byModel.has(k)) byModel.set(k, []);
    byModel.get(k).push(r);
}
line(`  ${"MODEL".padEnd(40)} ${SCENARIOS.map((s) => s.id.slice(0, 9).padEnd(10)).join("")} TOTAL`);
for (const [k, rs] of byModel) {
    const cells = SCENARIOS.map((s) => {
        const r = rs.find((x) => x.scenario.id === s.id);
        return (r ? (r.error ? "ERR" : `${r.passed}/${r.total}`) : "-").padEnd(10);
    }).join("");
    const p = rs.reduce((n, r) => n + r.passed, 0), t = rs.reduce((n, r) => n + r.total, 0);
    line(`  ${k.padEnd(40)} ${cells} ${p}/${t}`);
}
line();

line("PER-RUN DETAIL");
rule("═");
for (const r of results) {
    line();
    line(`${r.provider}:${r.model}  —  [${r.scenario.id}]`);
    rule();
    line(`  ${r.passed}/${r.total}   steps ${r.steps}   ${r.ms}ms`);
    if (r.error) line(`  ERROR: ${r.error}`);
    line("  tool calls:");
    if (!r.trace.length) line("    (none)");
    for (const t of r.trace) {
        line(`    ${t.name}${t.known ? "" : "   ← UNKNOWN TOOL"}`);
        const a = JSON.stringify(t.args ?? {});
        if (a !== "{}") line(`        ${a.length > 200 ? a.slice(0, 200) + "…" : a}`);
    }
    line("  reply:");
    line(r.text ? r.text.split("\n").map((x) => `    ${x}`).join("\n") : "    (none)");
    const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
    line(`  failed: ${failed.length ? failed.join(", ") : "none"}`);
}
line();

fs.writeFileSync("src/test/eval/eval-results.txt", L.join("\n"), "utf8");
const tp = results.reduce((n, r) => n + r.passed, 0), tt = results.reduce((n, r) => n + r.total, 0);
console.log(`\n${tp}/${tt} checks passed → src/test/eval/eval-results.txt`);
