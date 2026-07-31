/**
 * Hand-run:  node src/test/testRoutineGuard.js
 *
 * Covers the stage-3 wiring that has no other guard rail. Needs .env for
 * MONGO_DB_URI (mongoClient builds its client at import) but never connects,
 * so nothing here touches the database.
 */
import "dotenv/config";
import assert from "node:assert";

const tests = [];
const test = (n, f) => tests.push([n, f]);

// agent.js -> actionDispatcher -> goodMorningJob -> agent.js is a real cycle.
// It resolved before; the stage-3 imports must not tip it over.
test("module graph still loads despite the agent/job import cycle", async () => {
    await import("../scheduler/initCron.js");
    await import("../scheduler/executeTriggerJob.js");
    const gm = await import("../scheduler/jobs/goodMorningJob.js");
    const gn = await import("../scheduler/jobs/goodNightJob.js");
    assert.strictEqual(typeof gm.goodMorningJob, "function");
    assert.strictEqual(typeof gn.goodNightJob, "function");
});

test("routine guard and target resolver are exported", async () => {
    const { hasFlowStartedToday } = await import("../scheduler/flows/activeFlowsRepo.js");
    const { resolveRoutineTargets, LEGACY_USER } = await import("../agent/userManager.js");
    assert.strictEqual(typeof hasFlowStartedToday, "function");
    assert.strictEqual(typeof resolveRoutineTargets, "function");
    assert.strictEqual(LEGACY_USER.userId, 1136575387, "legacy fallback user must survive");
});

test("hourCycle h23 gives a usable 0-23 hour at every boundary", () => {
    const at = (iso, tz) =>
        Number(
            new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" })
                .format(new Date(iso))
        );

    // ROUTINE_HOURS compares with ===, so anything outside 0-23 silently never
    // fires. hour12:false is NOT used here because its midnight output varies
    // by ICU version ("24" on some, "00" on others) — h23 is specified.
    assert.strictEqual(at("2020-01-01T00:00:00Z", "UTC"), 0, "midnight must be 0, not 24");
    assert.strictEqual(at("2020-01-01T23:00:00Z", "UTC"), 23);
    // 00:00 UTC is 05:30 IST — the offset the whole codebase is anchored to.
    assert.strictEqual(at("2020-01-01T00:00:00Z", "Asia/Kolkata"), 5);
    // 03:30 UTC is 09:00 IST, exactly ROUTINE_HOURS.morning.
    assert.strictEqual(at("2020-01-01T03:30:00Z", "Asia/Kolkata"), 9);
});

test("morning prompt forbids re-fetching data it already inlines", async () => {
    const { goodMorningFlow } = await import("../agent/flows/goodMorningFlow.js");
    const p = goodMorningFlow.buildTriggerPrompt({ pendingTasks: "A", taskLogs: "B" });
    assert.match(p, /DO NOT FETCH IT/);
    assert.match(p, /NO tool calls/);
    assert.match(p, /fetchCollectionNameAndSchema/, "must name the tool it is overriding");
    assert.ok(p.includes("A") && p.includes("B"), "data must still be inlined");
});

test("usersSchema matches main's bare-default-export convention", async () => {
    const mod = await import("../tools/mongo/schema/usersSchema.js");
    assert.ok(mod.default, "no default export — createCollection would set $jsonSchema: undefined");
    assert.strictEqual(mod.default.bsonType, "object");
    assert.ok(!mod.default.validator, "must not pre-wrap; createCollection adds the wrapper");
    assert.ok(mod.default.required.includes("userId"));
});

test("executeTriggerJob short-circuits on daily quota instead of retrying", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../scheduler/executeTriggerJob.js", import.meta.url), "utf8");
    const quotaAt = src.indexOf('classifyQuotaError(err).kind === "RPD"');
    const retryAt = src.indexOf("attempts < maxAttempts");
    assert.ok(quotaAt > 0, "no RPD short-circuit");
    assert.ok(quotaAt < retryAt, "RPD check must come BEFORE the retry branch or it never runs");
});

test("agent loop is bounded", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../agent/agent.js", import.meta.url), "utf8");
    assert.match(src, /maxSteps/, "unbounded loop can drain the daily quota in one turn");
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
