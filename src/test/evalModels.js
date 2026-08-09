/**
 * Model eval — one realistic query, every model in scratch/docs/Models_Usage.
 *
 *   node src/test/evalModels.js                 all models
 *   node src/test/evalModels.js gemini          one provider
 *   node src/test/evalModels.js gemini:gemini-3.5-flash
 *
 * Writes src/test/eval-results.txt.
 *
 * ⚠️  REAL API CALLS (~2-4 per model).
 *
 * Design: REAL system instruction and REAL tool declarations from the registry
 * (so prompt weight matches production, ~4.5K tokens), but tool execution is
 * STUBBED. That keeps grading deterministic and stops 13 models writing junk
 * rows into Mongo. What is being measured is tool SELECTION and whether the
 * model can use a returned result — not the database.
 */
import "dotenv/config";
import fs from "fs";
import { createProvider } from "../agent/llm/createProvider.js";
import { buildSystemInstruction } from "../agent/instruction.js";
import toolRegistry from "../agent/tools/definitions/index.js";

const USER_ID = 1136575387;

// ── the query ──────────────────────────────────────────────────────────────
const QUERY = "How much did I spend on food this month?";

/**
 * Expected behaviour, per the system instruction:
 *   "For READ operations (fetch/search): MUST call fetchCollectionsAndSchema first"
 *   "fetchRecord ... Always include userId in filters"
 * so a correct run is:
 *   1. fetchCollectionNameAndSchema
 *   2. fetchRecord { collection:"expenseRegister", filters:{ userId, category:"Food", date range } }
 *   3. plain-text answer stating 1930
 * No writes. No other tools.
 */
const EXPECTED = [
    "1. fetchCollectionNameAndSchema   (system prompt mandates it before any read)",
    "2. fetchRecord                    collection=expenseRegister, filters include userId",
    "3. final text answer stating the total: 1930",
];

const STUB_ROWS = [
    { _id: "68a1", name: "Lunch - thali", amount: 250, category: "Food", date: "2026-08-02" },
    { _id: "68a2", name: "Groceries", amount: 1200, category: "Food", date: "2026-08-05" },
    { _id: "68a3", name: "Coffee", amount: 480, category: "Food", date: "2026-08-07" },
];
const EXPECTED_TOTAL = 1930; // 250 + 1200 + 480

const STUB = {
    fetchCollectionNameAndSchema: () => ({
        expenseRegister: {
            collectionName: "expenseRegister",
            schema: {
                properties: {
                    userId: { bsonType: "int" }, name: { bsonType: "string" },
                    amount: { bsonType: "double" },
                    category: { bsonType: "string", enum: ["Food", "Travel", "Shopping", "Medical", "Bills", "Entertainment", "Misc"] },
                    date: { bsonType: "date" }, month: { bsonType: "string" }, year: { bsonType: "int" },
                },
                required: ["name", "amount", "category", "date", "month", "year"],
            },
        },
        taskCalendar: { collectionName: "taskCalendar", schema: { properties: { title: { bsonType: "string" } } } },
    }),
    fetchRecord: (args) =>
        String(args?.collection) === "expenseRegister" ? STUB_ROWS
            : { error: `Collection "${args?.collection}" is not whitelisted.` },
};

// ── models under test (scratch/docs/Models_Usage) ───────────────────────────
const MODELS = [
    ["gemini", "gemini-3.5-flash"], ["gemini", "gemini-3.5-flash-lite"],
    ["gemini", "gemini-3.1-flash"], ["gemini", "gemini-3.1-flash-lite"],
    ["gemini", "gemini-2.5-flash"], ["gemini", "gemini-2.5-flash-lite"],
    ["groq", "qwen/qwen3.6-27b"], ["groq", "openai/gpt-oss-120b"],
    ["groq", "openai/gpt-oss-20b"], ["groq", "groq/compound"],
    ["cerebras", "gpt-oss-120b"], ["cerebras", "gemma-4-31b-preview"],
    ["cerebras", "zai-glm-4.7-preview"],
];

const MAX_STEPS = 6;

// Seconds to wait AFTER each model, so one model's spend does not 429 the
// next. TPM windows are per organisation, not per model: this eval burns ~9K
// tokens per run and Groq's free tier caps at 8K/min, so back-to-back Groq
// runs would fail for reasons that have nothing to do with the model.
const PACE_SEC = { groq: 70, cerebras: 15, gemini: 3, openrouter: 3, ollama: 0 };
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const tools = toolRegistry.getToolDeclarations();
const systemInstruction = buildSystemInstruction([]);

async function runOne(providerName, model) {
    const started = Date.now();
    const messages = [
        { role: "system", content: systemInstruction },
        { role: "user", content: QUERY },
    ];
    const trace = [];
    let finalText = null, error = null, steps = 0;

    let provider;
    try {
        provider = createProvider(providerName, undefined, model);
    } catch (e) {
        return { providerName, model, error: e.message, trace, steps: 0, ms: 0 };
    }

    while (steps < MAX_STEPS) {
        steps++;
        let res;
        try {
            res = await provider.chat(messages, tools);
        } catch (e) {
            error = e.message.replace(/\s+/g, " ").slice(0, 220);
            break;
        }

        if (!res.hasToolCalls()) { finalText = res.text || ""; break; }

        messages.push({ role: "assistant", content: res.text || null, toolCalls: res.toolCalls });
        for (const tc of res.toolCalls) {
            const stub = STUB[tc.name];
            const result = stub ? stub(tc.args) : { error: `Unknown tool "${tc.name}"` };
            trace.push({ step: steps, name: tc.name, args: tc.args, known: Boolean(stub) });
            messages.push({
                role: "tool_result", toolCallId: tc.id, toolName: tc.name,
                content: { success: Boolean(stub), message: stub ? "ok" : "unknown tool", data: result },
            });
        }
    }

    return { providerName, model, trace, finalText, error, steps, ms: Date.now() - started };
}

function grade(r) {
    const names = r.trace.map((t) => t.name);
    const fetchRec = r.trace.find((t) => t.name === "fetchRecord");
    const answered = r.finalText ? /1[,.]?930/.test(r.finalText) : false;

    const checks = {
        reachable: !r.error || r.trace.length > 0,
        calledSchemaFirst: names[0] === "fetchCollectionNameAndSchema",
        calledFetchRecord: Boolean(fetchRec),
        rightCollection: fetchRec ? String(fetchRec.args?.collection) === "expenseRegister" : false,
        userIdInFilters: fetchRec ? JSON.stringify(fetchRec.args?.filters || {}).includes(String(USER_ID)) : false,
        noWrites: !names.some((n) => /^(createRecord|updateRecords|createTask|insertSchedule|createCollection)$/.test(n)),
        noUnknownTools: r.trace.every((t) => t.known),
        answeredWithTotal: answered,
        cleanOutput: r.finalText ? !/<think>|<\|/.test(r.finalText) : false,
    };
    const passed = Object.values(checks).filter(Boolean).length;
    return { checks, passed, total: Object.keys(checks).length };
}

// ── run ────────────────────────────────────────────────────────────────────
const filter = process.argv[2];
const targets = MODELS.filter(([p, m]) =>
    !filter || p === filter || `${p}:${m}` === filter || m === filter);

console.log(`Eval: ${targets.length} model(s)\nQuery: "${QUERY}"\n`);

const results = [];
for (let i = 0; i < targets.length; i++) {
    const [p, m] = targets[i];
    process.stdout.write(`  ${`${p}:${m}`.padEnd(34)} … `);
    const r = await runOne(p, m);
    const g = grade(r);
    results.push({ ...r, ...g });
    console.log(`${g.passed}/${g.total}  ${r.error ? "ERROR " + r.error.slice(0, 60) : `${r.trace.map((t) => t.name).join(" → ") || "no tools"}`}`);

    const wait = i < targets.length - 1 ? (PACE_SEC[p] ?? 5) : 0;
    if (wait) { process.stdout.write(`  ${" ".repeat(34)}   (pacing ${wait}s)\r`); await sleep(wait); process.stdout.write(" ".repeat(60) + "\r"); }
}

// ── report ─────────────────────────────────────────────────────────────────
const L = [];
const line = (s = "") => L.push(s);
const rule = (c = "─") => line(c.repeat(78));

line("RASMALAI — MODEL EVAL");
rule("═");
line(`Generated : ${new Date().toISOString()}`);
line(`Models    : ${targets.length} (from scratch/docs/Models_Usage)`);
line(`Prompt    : real system instruction + all ${tools.length} registry tool declarations`);
line(`Execution : STUBBED — deterministic grading, nothing written to Mongo`);
line();
line("USER QUERY");
rule();
line(`  "${QUERY}"`);
line();
line("EXPECTED BEHAVIOUR");
rule();
EXPECTED.forEach((e) => line(`  ${e}`));
line();
line(`  Stub data returned by fetchRecord (${STUB_ROWS.length} Food rows):`);
STUB_ROWS.forEach((r) => line(`    ₹${String(r.amount).padStart(5)}  ${r.name}  (${r.date})`));
line(`    total = ${EXPECTED_TOTAL}`);
line();
line("GRADING");
rule();
[
    "reachable          model responded at all",
    "calledSchemaFirst  first call is fetchCollectionNameAndSchema (prompt mandates it)",
    "calledFetchRecord  attempted the read",
    "rightCollection    fetchRecord collection = expenseRegister",
    "userIdInFilters    filters contain the userId (prompt mandates it)",
    "noWrites           no create/update tool touched on a read-only query",
    "noUnknownTools     never invented a tool name",
    "answeredWithTotal  final text states 1930",
    "cleanOutput        no <think> / control tokens leaked into the reply",
].forEach((s) => line(`  ${s}`));
line();
line("SUMMARY");
rule("═");
line(`  ${"MODEL".padEnd(34)} ${"SCORE".padEnd(7)} ${"STEPS".padEnd(6)} ${"TIME".padEnd(8)} RESULT`);
for (const r of results) {
    const verdict = r.error ? "ERROR"
        : r.passed === r.total ? "PASS"
        : r.checks.answeredWithTotal ? "PARTIAL"
        : "FAIL";
    line(`  ${`${r.providerName}:${r.model}`.padEnd(34)} ${`${r.passed}/${r.total}`.padEnd(7)} ${String(r.steps).padEnd(6)} ${`${r.ms}ms`.padEnd(8)} ${verdict}`);
}
line();
const pass = results.filter((r) => r.passed === r.total).length;
line(`  ${pass}/${results.length} fully correct`);
line();
line("READING THE FAILURES");
rule();
[
    "Groq (all ids)     TPM, not capability. Step 1 succeeds; step 2 returns",
    "                   429 'TPM: Limit 8000, Used 5776'. This prompt costs",
    "                   ~5K tokens for step 1 and ~4K more for step 2, so a",
    "                   two-step tool loop cannot fit in an 8K/min window.",
    "                   Under a saturated org-wide window Groq also reports a",
    "                   misleading 'invalid JSON schema' 400 — the schemas are",
    "                   valid and pass in isolation. Scoping tools per task",
    "                   (~2.7K of the prompt is tool declarations) is what",
    "                   would make Groq viable.",
    "Cerebras           402 Payment Required — the free tier needs purchased",
    "                   credits. Not a free provider for this workload.",
    "gemini-3.1-flash   404, model does not exist on this account despite",
    "                   appearing in the dashboard notes.",
    "2.5-flash-lite     Reachable, but stops after the first tool call and",
    "                   never completes the read. Weak at multi-step loops.",
].forEach((s) => line(`  ${s}`));
line();
line("PER-MODEL DETAIL");
rule("═");
for (const r of results) {
    line();
    line(`${r.providerName}:${r.model}`);
    rule();
    line(`  score ${r.passed}/${r.total}   steps ${r.steps}   ${r.ms}ms`);
    if (r.error) line(`  ERROR: ${r.error}`);
    line(`  tool calls:`);
    if (!r.trace.length) line("    (none)");
    for (const t of r.trace) {
        line(`    step ${t.step}  ${t.name}${t.known ? "" : "   ← UNKNOWN TOOL"}`);
        const a = JSON.stringify(t.args ?? {});
        if (a !== "{}") line(`             args ${a.length > 160 ? a.slice(0, 160) + "…" : a}`);
    }
    line(`  final answer:`);
    line(r.finalText ? r.finalText.split("\n").map((x) => `    ${x}`).join("\n") : "    (none)");
    const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
    line(`  failed checks: ${failed.length ? failed.join(", ") : "none"}`);
}
line();

const out = "src/test/eval-results.txt";
fs.writeFileSync(out, L.join("\n"), "utf8");
console.log(`\n${pass}/${results.length} fully correct → ${out}`);
