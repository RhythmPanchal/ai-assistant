/**
 * Hand-run:  node src/test/eval/measurePromptSize.js
 *
 * What one request weighs, where the weight is, and what scoping would save.
 * Providers cap TOKENS PER MINUTE, so this decides which of them can run a
 * multi-step tool loop at all. Offline. ~4 chars/token, adequate for planning.
 */
import "dotenv/config";
import { buildSystemInstruction } from "../../agent/instruction.js";
import toolRegistry from "../../agent/tools/definitions/index.js";
import goodNightFlow from "../../agent/flows/goodNightFlow.js";
import goodMorningFlow from "../../agent/flows/goodMorningFlow.js";

const tok = (s) => Math.ceil((typeof s === "string" ? s.length : s) / 4);
const pad = (n) => String(n).padStart(6);

const decls = toolRegistry.getToolDeclarations();
const byTool = decls
    .map((d) => ({ name: d.name, t: tok(JSON.stringify(d)) }))
    .sort((a, b) => b.t - a.t);

const base = tok(buildSystemInstruction([]));
const night = tok(buildSystemInstruction([goodNightFlow.instruction]));
const morning = tok(buildSystemInstruction([goodMorningFlow.instruction]));
const allTools = byTool.reduce((n, x) => n + x.t, 0);

console.log("\n1. WHERE THE TOKENS ARE  (per request, before history)\n");
console.log(`  persona + live time                ${pad(base)}`);
console.log(`  all ${decls.length} tool declarations         ${pad(allTools)}`);
console.log(`  goodNight overlay adds             ${pad(night - base)}`);
console.log(`  goodMorning overlay adds           ${pad(morning - base)}`);

console.log("\n2. COST PER TOOL DECLARATION\n");
for (const { name, t } of byTool) {
    const bar = "█".repeat(Math.max(1, Math.round(t / 30)));
    console.log(`  ${name.padEnd(30)} ${pad(t)}  ${bar}`);
}

// What each task can plausibly need. goodMorning's draft is tool-free by
// design (its prompt forbids tool calls), which makes it the cheapest of all.
const SCOPE = {
    conversation: ["fetchCollectionNameAndSchema", "fetchRecord", "createRecord", "updateRecords",
                   "createTask", "createOneTimeReminder", "createMultiTimeReminder", "completeFlow"],
    goodMorning: [],
    goodNight: ["fetchCollectionNameAndSchema", "fetchRecord", "createRecord", "updateRecords", "completeFlow"],
    summarize: ["fetchCollectionNameAndSchema", "fetchRecord"],
    ingest: ["fetchCollectionNameAndSchema", "createTask", "createRecord"],
};

const cost = (names) => byTool.filter((x) => names.includes(x.name)).reduce((n, x) => n + x.t, 0);
const overlayFor = (t) => (t === "goodNight" ? night - base : t === "goodMorning" ? morning - base : 0);

console.log("\n3. IF TOOLS WERE SCOPED PER TASK\n");
console.log(`  ${"task".padEnd(14)} ${"tools".padEnd(7)} ${"now".padEnd(8)} ${"scoped".padEnd(8)} saved`);
const scoped = {};
for (const [task, names] of Object.entries(SCOPE)) {
    const now = base + overlayFor(task) + allTools;
    const then = base + overlayFor(task) + cost(names);
    scoped[task] = then;
    const pct = Math.round((1 - then / now) * 100);
    console.log(`  ${task.padEnd(14)} ${String(names.length).padEnd(7)} ${pad(now)}  ${pad(then)}  ${String(pct).padStart(3)}%`);
}

console.log("\n4. DOES IT FIT A GROQ-SIZED WINDOW?  (8K tokens/minute)\n");
const TPM = 8000;
console.log("  A tool loop sends the whole conversation again each step, so step N");
console.log("  costs roughly N x the base. Steps that fit inside one 8K minute:\n");
console.log(`  ${"task".padEnd(14)} ${"now".padEnd(22)} scoped`);
for (const task of Object.keys(SCOPE)) {
    const now = base + overlayFor(task) + allTools;
    const then = scoped[task];
    const stepsIn = (per) => {
        let total = 0, n = 0;
        while (total + per * (n + 1) <= TPM) { n++; total += per * n; }
        return n;
    };
    const a = stepsIn(now), b = stepsIn(then);
    const verdict = (n) => (n === 0 ? "does not fit" : `${n} step${n > 1 ? "s" : ""}`);
    console.log(`  ${task.padEnd(14)} ${verdict(a).padEnd(22)} ${verdict(b)}`);
}

console.log("\n5. THE OTHER LEVER: FEWER CALLS, NOT SMALLER ONES\n");
const schemaTool = byTool.find((x) => x.name === "fetchCollectionNameAndSchema");
console.log("  The system prompt mandates fetchCollectionNameAndSchema before any");
console.log("  read, which spends a whole request to fetch static text. Inlining the");
console.log("  2-3 schemas a task actually touches removes that round trip — the");
console.log("  goodNight overlay already does exactly this.");
console.log(`\n  cost of keeping the tool     ${pad(schemaTool.t)} tokens on EVERY request + 1 request/turn`);
console.log(`  cost of inlining ~3 schemas  ${pad(900)} tokens on every request, 0 extra requests`);
console.log("\n  Which wins depends on what binds:");
console.log("    Gemini  250K TPM, low RPD  -> requests scarce, tokens cheap  -> INLINE");
console.log("    Groq      8K TPM, 1K RPD   -> tokens scarce, requests cheap  -> KEEP TOOL");
console.log("\n  These are opposite strategies, so the choice belongs per task chain,");
console.log("  not globally.\n");
