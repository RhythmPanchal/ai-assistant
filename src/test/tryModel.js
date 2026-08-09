/**
 * Probe one model, or every model a provider exposes.
 *
 *   node src/test/tryModel.js --providers
 *   node src/test/tryModel.js --list groq                  discover ids on this account
 *   node src/test/tryModel.js groq openai/gpt-oss-120b
 *   node src/test/tryModel.js gemini gemini-3.5-flash "why is the sky blue?"
 *   node src/test/tryModel.js --all groq                   every id the provider lists
 *   node src/test/tryModel.js --all groq --filter oss      only ids containing "oss"
 *
 * ⚠️  REAL API CALLS. --all costs 3 per model, so --filter first.
 *
 * Three stages, because a model can pass one and fail the next:
 *   1 TEXT      plain generation
 *   2 TOOL      does it emit a tool call at all
 *   3 ROUNDTRIP feed the tool RESULT back and get a final answer
 *
 * Stage 3 is the one that matters. It replays the exact message shape
 * agent.js builds — an assistant turn with `content: null` plus toolCalls,
 * followed by a tool_result turn. Providers differ on whether they accept a
 * null assistant content or an unpaired tool message, and a model that fails
 * only here will loop forever inside runAgent rather than erroring cleanly.
 */
import "dotenv/config";
import { createProvider, listProviders } from "../agent/llm/createProvider.js";

const TOOL = {
    name: "getExpenseTotal",
    description: "Get the user's total spending for a month.",
    parameters: {
        type: "object",
        properties: { month: { type: "string", description: "Month name, e.g. 'August'." } },
        required: ["month"],
    },
};

const ms = (t) => `${Date.now() - t}ms`;
const short = (s, n = 90) => String(s).replace(/\s+/g, " ").slice(0, n);

async function probe(providerName, model, query) {
    const p = createProvider(providerName, undefined, model);
    const out = { model, stages: {} };

    // ── 1. text ─────────────────────────────────────────────────────────
    let t = Date.now();
    try {
        const r = await p.chat(
            [{ role: "system", content: "Answer in one short sentence." },
             { role: "user", content: query || "What is the capital of France?" }],
            []
        );
        out.stages.text = r.text ? { ok: true, ms: ms(t), sample: short(r.text, 60) }
                                 : { ok: false, err: "empty response" };
    } catch (e) {
        out.stages.text = { ok: false, err: short(e.message) };
        return out; // nothing else can pass
    }

    // ── 2. tool call ────────────────────────────────────────────────────
    const askForTool = [
        { role: "system", content: "You answer spending questions using the tools provided." },
        { role: "user", content: "How much did I spend in August?" },
    ];
    let toolCalls;
    t = Date.now();
    try {
        const r = await p.chat(askForTool, [TOOL]);
        toolCalls = r.toolCalls;
        out.stages.tool = r.hasToolCalls()
            ? { ok: true, ms: ms(t), sample: `${toolCalls[0].name}(${JSON.stringify(toolCalls[0].args)})` }
            : { ok: false, err: "no tool call emitted" };
    } catch (e) {
        out.stages.tool = { ok: false, err: short(e.message) };
        return out;
    }
    if (!toolCalls?.length) return out;

    // ── 3. tool-result round trip ───────────────────────────────────────
    // Exactly what agent.js pushes: assistant(content:null, toolCalls) then tool_result.
    const withResult = [
        ...askForTool,
        { role: "assistant", content: null, toolCalls },
        {
            role: "tool_result",
            toolCallId: toolCalls[0].id,
            toolName: toolCalls[0].name,
            content: { success: true, message: "Total fetched", data: { total: 12450, currency: "INR" } },
        },
    ];
    t = Date.now();
    try {
        const r = await p.chat(withResult, [TOOL]);
        if (r.hasToolCalls()) {
            out.stages.roundtrip = { ok: false, err: "re-called the tool instead of answering (loop risk)" };
        } else if (!r.text) {
            out.stages.roundtrip = { ok: false, err: "no text after tool result" };
        } else {
            out.stages.roundtrip = {
                ok: true, ms: ms(t), sample: short(r.text, 60),
                // Did it actually read the tool result, or just talk?
                usedResult: /12,?450/.test(r.text),
            };
        }
    } catch (e) {
        out.stages.roundtrip = { ok: false, err: short(e.message) };
    }
    return out;
}

function render(providerName, r) {
    const mark = (s) => (!s ? "   -" : s.ok ? "  ok" : "FAIL");
    console.log(`\n  ${providerName}:${r.model}`);
    for (const [stage, s] of Object.entries(r.stages)) {
        const detail = s.ok
            ? `${s.ms.padStart(7)}  ${s.sample}${s.usedResult === false ? "   ⚠ ignored the tool result" : ""}`
            : s.err;
        console.log(`    ${mark(s).padEnd(5)} ${stage.padEnd(10)} ${detail}`);
    }
    const verdict = r.stages.roundtrip?.ok ? "USABLE by runAgent"
        : r.stages.tool?.ok ? "tool calls work but the round trip does not — would loop in runAgent"
        : r.stages.text?.ok ? "text only — no tool calling"
        : "unreachable";
    console.log(`    → ${verdict}`);
    return r.stages.roundtrip?.ok === true;
}

// ── CLI ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagIdx = argv.findIndex((a) => a === "--filter");
const filter = flagIdx >= 0 ? argv[flagIdx + 1] : null;
const args = flagIdx >= 0 ? argv.filter((_, i) => i !== flagIdx && i !== flagIdx + 1) : argv;

if (args[0] === "--providers" || args.length === 0) {
    console.log(`providers: ${listProviders().join(", ")}`);
    console.log("usage: node src/test/tryModel.js <provider> <model> [query]");
    console.log("       node src/test/tryModel.js --list <provider>");
    console.log("       node src/test/tryModel.js --all <provider> [--filter <substr>]");
    process.exit(0);
}

if (args[0] === "--list" || args[0] === "--all") {
    const providerName = args[1];
    if (!providerName) { console.error("need a provider name"); process.exit(1); }

    let ids;
    try {
        ids = await createProvider(providerName).listModels();
    } catch (e) {
        console.error(`could not list models for ${providerName}: ${short(e.message, 160)}`);
        process.exit(1);
    }
    if (filter) ids = ids.filter((i) => i.includes(filter));

    if (args[0] === "--list") {
        console.log(`${providerName} — ${ids.length} model(s)${filter ? ` matching "${filter}"` : ""}:`);
        ids.forEach((i) => console.log(`  ${i}`));
        process.exit(0);
    }

    console.log(`Probing ${ids.length} model(s) on ${providerName} — 3 calls each\n`);
    let usable = 0;
    for (const id of ids) {
        try { if (render(providerName, await probe(providerName, id))) usable++; }
        catch (e) { console.log(`\n  ${providerName}:${id}\n    FAIL  ${short(e.message, 120)}`); }
    }
    console.log(`\n${usable}/${ids.length} usable by runAgent (all three stages)`);
    process.exit(usable ? 0 : 1);
}

const [providerName, model, ...rest] = args;
const ok = render(providerName, await probe(providerName, model, rest.join(" ") || null));
console.log("");
process.exit(ok ? 0 : 1);
