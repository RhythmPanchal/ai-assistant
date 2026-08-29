/**
 * Hand-run:  node src/test/testAllToolsWithContext.js
 *
 * Every registered tool, invoked through the real registry with a real bound
 * context. The claim being checked is narrow and worth checking exhaustively:
 * no tool fails for want of an identity now that userId is no longer a
 * parameter. A tool that still expected the model to supply one would fail here
 * and nowhere else until a user hit it in production.
 *
 * Writes are redirected to a throwaway database, dropped at the end, because
 * some tools DO write when called. getDB() reads MONGODB_DB_NAME at call time,
 * so setting it before the first import sends every connection there.
 */
import "dotenv/config";

const SCRATCH_DB = "Rasmalai-ctxtest";
process.env.MONGODB_DB_NAME = SCRATCH_DB;

import assert from "node:assert";

const { runWithUserContext, runAsSystem } = await import("../identity/userContext.js");
const { getDB } = await import("../tools/mongo/mongoClient.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;

const tests = [];
const test = (n, f) => tests.push([n, f]);

const CONTEXT_ERROR = /no user context bound/;

/**
 * Minimal args per tool — enough to get past argument validation and reach the
 * point where identity would be needed. Deliberately harmless: bad ids, empty
 * batches, unknown names. The failures these produce are the point; what must
 * NOT appear is a context error.
 */
const ARGS = {
    fetchCollectionNameAndSchema: {},
    createCollection: { collectionName: "nope" },
    createRecord: { collectionName: "expenseRegister", data: {} },
    fetchRecord: { collection: "expenseRegister", filters: {} },
    updateRecords: { records: [{ collectionName: "taskCalendar", id: "aaaaaaaaaaaaaaaaaaaaaaaa", data: { title: "x" } }] },
    deleteRecord: { collectionName: "expenseRegister", id: "aaaaaaaaaaaaaaaaaaaaaaaa", reason: "test" },
    createTask: { title: "" },
    insertSchedule: { date: "2026-01-01", slots: [] },
    createOneTimeReminder: { title: "", nextExecutionAt: "2020-01-01T00:00:00", message: "" },
    createMultiTimeReminder: { title: "", cron: "bad", nextExecutionAt: "2020-01-01T00:00:00", message: "", expiryDate: "2020-01-01" },
    completeFlow: { flowType: "goodMorning", reason: "done" },
    updateFlowScratchpad: { flowType: "goodMorning", scratchpad: {} },
    connectApp: { appName: "unknownApp" },
    disconnectApp: { appName: "unknownApp" },
    rememberFact: { facts: [] },
    fetchUserContext: {},
    loadSkill: { skill: "userContextEnrichment" },
    updateUserSettings: {},
    forgetFact: { keys: [] },
    manageFactKey: { action: "remove", key: "does.notexist" },
    updateTaskStatus: { updates: [] },
    deferTask: { task: "", newDeadline: "2020-01-01" },
};

const allTools = toolRegistry.getAllTools().map(t => t.constructor.name);

test("every registered tool has a case here", () => {
    const missing = allTools.filter(n => !(n in ARGS));
    assert.deepStrictEqual(missing, [],
        `no coverage for: ${missing.join(", ")} — add args above so the sweep stays exhaustive`);
});

test("no tool fails for want of an identity, as a user", async () => {
    const contextFailures = [];
    const outcomes = [];

    await runWithUserContext({ userId: 1, channel: "test" }, async () => {
        for (const name of allTools) {
            const result = await toolRegistry.execute(name, ARGS[name]);
            const message = String(result?.message ?? "");
            if (CONTEXT_ERROR.test(message)) contextFailures.push(`${name}: ${message}`);
            outcomes.push(`${result?.success ? "ok  " : "err "} ${name}`);
        }
    });

    console.log("      " + outcomes.join("\n      "));
    assert.deepStrictEqual(contextFailures, [],
        `these tools could not see the bound identity:\n  ${contextFailures.join("\n  ")}`);
});

test("no tool fails for want of an identity, as the system", async () => {
    // Migrations and maintenance run here. Nothing may be blocked by scoping —
    // system work legitimately crosses users, so isSystem skips the filter
    // rather than filtering to -1, which would match nothing.
    const contextFailures = [];

    await runAsSystem("tool sweep", async () => {
        for (const name of allTools) {
            const result = await toolRegistry.execute(name, ARGS[name]);
            if (CONTEXT_ERROR.test(String(result?.message ?? ""))) {
                contextFailures.push(`${name}: ${result.message}`);
            }
        }
    });

    assert.deepStrictEqual(contextFailures, [],
        `system context must never be blocked:\n  ${contextFailures.join("\n  ")}`);
});

test("every tool IS blocked without an identity", async () => {
    // The other half. If a tool can run unbound, it can run unscoped.
    const ranAnyway = [];
    for (const name of allTools) {
        try {
            const result = await toolRegistry.execute(name, ARGS[name]);
            if (!CONTEXT_ERROR.test(String(result?.message ?? ""))) ranAnyway.push(name);
        } catch (err) {
            // A throw is the expected refusal; anything else means it got far
            // enough to fail on its own arguments, i.e. it ran unscoped.
            if (!CONTEXT_ERROR.test(err.message)) ranAnyway.push(`${name} (${err.message})`);
        }
    }

    // fetchCollectionNameAndSchema, createCollection and loadSkill touch no user
    // data at all — schemas and skill definitions are the same for everyone.
    const OWNERLESS = ["fetchCollectionNameAndSchema", "createCollection", "loadSkill"];
    const leaked = ranAnyway.filter(n => !OWNERLESS.includes(n));
    assert.deepStrictEqual(leaked, [],
        `these ran with no identity bound: ${leaked.join(", ")}`);
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

// Never leave the scratch database behind.
try {
    const db = await getDB();
    assert.strictEqual(db.databaseName, SCRATCH_DB, "refusing to drop anything but the scratch db");
    await db.dropDatabase();
    console.log(`\ndropped scratch database ${SCRATCH_DB}`);
} catch (e) {
    console.log(`\ncould not drop ${SCRATCH_DB}: ${e.message}`);
}

console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
