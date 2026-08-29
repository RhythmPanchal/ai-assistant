/**
 * Hand-run:  node src/test/testToolRegistry.js
 *
 * Guards the toolOperator -> ToolRegistry port: the registry must expose every
 * tool the old declarations did, with the same names and required params. A
 * dropped tool is silent at boot and only shows up as the model being unable
 * to do something it used to.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import), but
 * never connects.
 */
import "dotenv/config";
import assert from "node:assert";
import { tools as legacyTools } from "../agent/toolOperator.js";
import toolRegistry from "../agent/tools/definitions/index.js";

// Registered after the port, absent from toolOperator. Anything NOT listed here
// showing up as an extra means an unreviewed capability reached the model.
// deleteRecord is scoped to the three day registers only — see
// DELETABLE_COLLECTIONS in tools/mongo/deleteRecord.js.
// rememberFact writes only to userFact, only for the userId it is given, and
// every key it accepts must match KEY_PATTERN. It cannot reach any other
// collection, and userFact is not in the fetchRecord whitelist, so the model can
// write facts but cannot query them back — it sees them only as injected prompt.
// fetchUserContext is read-only and scoped to the userId it is given. Its three
// siblings in ProfileTools.js — updateUserSettings, forgetFact, manageFactKey —
// are deliberately NOT registered here; they load with the userContextEnrichment
// skill, so a normal turn cannot reach them.
// loadSkill is the one always-present door to everything undeclared. It cannot
// reach data itself — it returns an instruction and a tool list, and only the
// agent loop acts on them, against the explicit SKILLS map.
// updateTaskStatus and deferTask write to taskCalendar only, only for the userId
// they are given, and only to fields describing a task's own lifecycle — status,
// deadline, notes. They cannot create a task or reach another collection. They
// are declared rather than skill-loaded because the failure they exist for is
// not scoped to a routine: on 2026-08-22 the user said a task was already done
// during the morning flow, the agent acknowledged it and called nothing, and the
// task was still Pending ten days later. That sentence can arrive at any hour.
const INTENTIONAL_ADDITIONS = new Set([
    "updateFlowScratchpad", "deleteRecord", "rememberFact", "fetchUserContext", "loadSkill",
    "updateTaskStatus", "deferTask",
]);
// Present in toolOperator but deliberately dropped.
const INTENTIONAL_REMOVALS = new Set();

const legacy = new Map(legacyTools[0].functionDeclarations.map((d) => [d.name, d]));
const ported = new Map(toolRegistry.getToolDeclarations().map((d) => [d.name, d]));

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("static `name` shadows the class name, so registry keys are wire names", () => {
    // BaseTool keys off this.constructor.name; that only yields "createRecord"
    // because `static name = ...` overrides Function.prototype.name.
    assert.ok(ported.has("createRecord"), `keys were: ${[...ported.keys()].join(", ")}`);
    assert.ok(!ported.has("CreateRecordTool"), "registry keyed on class name, not wire name");
});

test("every legacy tool survived the port", () => {
    const missing = [...legacy.keys()].filter((n) => !ported.has(n) && !INTENTIONAL_REMOVALS.has(n));
    assert.deepStrictEqual(missing, [], `dropped by the port: ${missing.join(", ")}`);
});

test("the OAuth tools master deleted are back", () => {
    assert.ok(ported.has("connectApp"));
    assert.ok(ported.has("disconnectApp"));
});

test("no unreviewed tool was added", () => {
    const extra = [...ported.keys()].filter((n) => !legacy.has(n) && !INTENTIONAL_ADDITIONS.has(n));
    assert.deepStrictEqual(extra, [], `unexpected new tools: ${extra.join(", ")}`);
});

test("sendMessage stays scheduler-only", () => {
    assert.ok(!ported.has("sendMessage"), "model must not be able to send arbitrary Telegram messages");
});

test("required params unchanged for every shared tool, apart from userId", () => {
    // userId is deliberately gone from every declaration — it now comes from the
    // bound user context instead of from the model. Anything ELSE dropping out
    // of required is still drift and still a bug.
    const drift = [];
    for (const [name, decl] of ported) {
        const old = legacy.get(name);
        if (!old) continue;
        const a = [...(old.parameters?.required || [])].filter(p => p !== "userId").sort();
        const b = [...(decl.parameters?.required || [])].sort();
        if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(`${name}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
    assert.deepStrictEqual(drift, [], `required-param drift:\n  ${drift.join("\n  ")}`);
});

test("no declaration exposes userId to the model", () => {
    // The invariant that replaces the parameter. A tool that reintroduces userId
    // hands the model back the ability to name whose data it is acting on, which
    // is the whole vulnerability this removed.
    const offenders = [];
    for (const tool of toolRegistry.getAllTools()) {
        const decl = tool.toFunctionDeclaration();
        const params = JSON.stringify(decl.parameters ?? {});
        if (/"userId"\s*:/.test(params) || (decl.parameters?.required ?? []).includes("userId")) {
            offenders.push(decl.name);
        }
    }
    assert.deepStrictEqual(offenders, [],
        `these declarations still let the model choose a userId: ${offenders.join(", ")}`);
});

test("every tool has a non-empty description and is executable", () => {
    for (const t of toolRegistry.getAllTools()) {
        const d = t.toFunctionDeclaration();
        assert.ok(d.description?.length > 20, `${d.name} has a thin description`);
        assert.strictEqual(typeof t.execute, "function", `${d.name} is not executable`);
    }
});

test("descriptions are clean UTF-8 (master shipped mojibake em-dashes)", () => {
    const bad = toolRegistry
        .getToolDeclarations()
        .filter((d) => /â€|Ã¢|﻿/.test(JSON.stringify(d)))
        .map((d) => d.name);
    assert.deepStrictEqual(bad, [], `corrupted text in: ${bad.join(", ")}`);
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
console.log(`\nlegacy=${legacy.size} ported=${ported.size}`);
console.log(`${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
