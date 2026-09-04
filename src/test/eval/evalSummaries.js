/**
 * Hand-run:  node src/test/eval/evalSummaries.js
 *            node src/test/eval/evalSummaries.js --repeat 3
 *            node src/test/eval/evalSummaries.js --only state-resolves --show
 *
 * Runs every scenario in summaryScenarios.js through the real summarize chain
 * and checks what came back. Spends one request per scenario per repeat.
 *
 * Writes nothing. The point is the prompt, not the collection.
 *
 * --repeat is the one worth using before changing the instruction: these models
 * are non-deterministic, and a rule that holds once may hold two times in three.
 */
import "dotenv/config";
import { summarizeDay, buildMessages } from "../../agent/summarize/summarizeDay.js";
import ValidateSchema from "../../tools/mongo/validateSchema.js";
import { CHAT_SUMMARY } from "../../tools/mongo/schema/chatSummarySchema.js";
import { SCENARIOS } from "./summaryScenarios.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const repeat = Number(flag("repeat", 1));
const only = flag("only", null);
const show = args.includes("--show");

const scenarios = only ? SCENARIOS.filter(s => s.name === only) : SCENARIOS;
if (!scenarios.length) {
    console.error(`No scenario named "${only}". Known: ${SCENARIOS.map(s => s.name).join(", ")}`);
    process.exit(1);
}

const text = (row, field) => {
    const v = row[field];
    return Array.isArray(v) ? v.join(" | ") : String(v ?? "");
};

/** @returns {{ok: boolean, label: string, detail?: string}[]} */
function runChecks(scenario, row) {
    return scenario.checks.map((check) => {
        if (check.fn) {
            return { ok: Boolean(check.fn(row)), label: check.why };
        }
        const haystack = text(row, check.field);
        if (check.must) {
            return {
                ok: check.must.test(haystack),
                label: `${check.field} says ${check.must} — ${check.why}`,
                detail: haystack || "(empty)",
            };
        }
        return {
            ok: !check.mustNot.test(haystack),
            label: `${check.field} avoids ${check.mustNot} — ${check.why}`,
            detail: haystack || "(empty)",
        };
    });
}

const results = [];

for (const scenario of scenarios) {
    for (let run = 1; run <= repeat; run++) {
        const messages = buildMessages({
            logDate: scenario.logDate,
            transcript: scenario.transcript,
            previous: scenario.previous,
        });
        const inTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);

        const record = { name: scenario.name, run, inTokens, why: scenario.why };
        try {
            const { row, provider, model } = await summarizeDay({
                userId: 1,
                logDate: scenario.logDate,
                transcript: scenario.transcript,
                previous: scenario.previous,
            });

            record.model = `${provider}:${model}`;
            record.row = row;
            record.outTokens = Math.ceil(JSON.stringify(row).length / 4);

            try {
                await ValidateSchema(CHAT_SUMMARY, row);
                record.schema = true;
            } catch (e) {
                record.schema = false;
                record.schemaError = e.message;
            }

            record.checks = runChecks(scenario, row);
        } catch (err) {
            record.error = err.message;
            record.checks = [];
        }
        results.push(record);
        process.stdout.write(".");
    }
}

// ------------------------------------------------------------------ report --
const pad = (s, n) => String(s).padEnd(n);
console.log("\n");
console.log("=".repeat(92));
console.log("DAY SUMMARY EVAL");
console.log("=".repeat(92));
console.log(`${pad("scenario", 17)}${pad("run", 5)}${pad("model", 30)}${pad("in", 7)}${pad("out", 6)}${pad("schema", 8)}checks`);
console.log("-".repeat(92));

for (const r of results) {
    if (r.error) {
        console.log(`${pad(r.name, 17)}${pad(r.run, 5)}${pad("—", 30)}${pad(r.inTokens, 7)}${pad("—", 6)}${pad("—", 8)}ERROR`);
        continue;
    }
    const good = r.checks.filter(c => c.ok).length;
    const mark = good === r.checks.length && r.schema ? "" : "  <-";
    console.log(
        `${pad(r.name, 17)}${pad(r.run, 5)}${pad(r.model, 30)}${pad(r.inTokens, 7)}${pad(r.outTokens, 6)}` +
        `${pad(r.schema ? "ok" : "FAIL", 8)}${good}/${r.checks.length}${mark}`
    );
}

const failures = results.filter(r => r.error || !r.schema || r.checks.some(c => !c.ok));
if (failures.length) {
    console.log("\n" + "=".repeat(92));
    console.log("WHAT FAILED");
    console.log("=".repeat(92));
    for (const r of failures) {
        console.log(`\n${r.name} (run ${r.run}) — ${r.why}`);
        if (r.error) { console.log(`  ERROR: ${r.error}`); continue; }
        if (!r.schema) console.log(`  SCHEMA: ${r.schemaError}`);
        for (const c of r.checks.filter(x => !x.ok)) {
            console.log(`  ✗ ${c.label}`);
            if (c.detail) console.log(`      got: ${c.detail}`);
        }
        console.log(`  row: ${JSON.stringify(r.row)}`);
    }
}

if (show) {
    console.log("\n" + "=".repeat(92));
    console.log("ROWS");
    console.log("=".repeat(92));
    for (const r of results.filter(x => x.row)) {
        console.log(`\n--- ${r.name} (run ${r.run}) ---`);
        console.log(JSON.stringify(r.row, null, 2));
    }
}

const totalChecks = results.reduce((n, r) => n + r.checks.length, 0);
const passedChecks = results.reduce((n, r) => n + r.checks.filter(c => c.ok).length, 0);
const clean = results.filter(r => !r.error && r.schema && r.checks.every(c => c.ok)).length;

console.log("\n" + "-".repeat(92));
console.log(`${clean}/${results.length} runs fully clean · ${passedChecks}/${totalChecks} checks passed · ${results.length} requests spent`);
console.log();

process.exit(failures.length ? 1 : 0);
