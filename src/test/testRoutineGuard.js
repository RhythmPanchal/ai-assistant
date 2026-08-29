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
    const { resolveRoutineTargets, LEGACY_USER } = await import("../identity/userManager.js");
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

test("the morning routine's data is system-side, not inlined in a user message", async () => {
    // It used to be inlined, along with a shouted instruction not to re-fetch
    // it. Being on the user side meant it was written to chatHistory verbatim
    // and replayed on every later turn, frozen at 09:00 — asked at 15:50 what
    // was pending, the agent answered off a six-hour-old list.
    const { goodMorningFlow } = await import("../agent/flows/goodMorningFlow.js");

    const prompt = goodMorningFlow.buildTriggerPrompt();
    assert.ok(prompt.length < 200, "the trigger is a knock on the door, not a payload");

    assert.strictEqual(typeof goodMorningFlow.buildContext, "function",
        "no buildContext means the overlay has no data and the routine plans blind");
    // The do-not-fetch rule has to travel with the data it protects, or it
    // forbids reading something that was never supplied.
    assert.match(goodMorningFlow.instruction, /LIVE DATA/,
        "the procedure must reference the block buildContext produces");
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

test("flows expire on a real-world condition, not a stopwatch", async () => {
    const { goodMorningFlow } = await import("../agent/flows/goodMorningFlow.js");
    const { goodNightFlow } = await import("../agent/flows/goodNightFlow.js");
    const hourIn = (d, tz) => Number(new Intl.DateTimeFormat("en-US",
        { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d));

    // A schedule is useless once the working day is over.
    assert.strictEqual(hourIn(goodMorningFlow.computeExpiry("Asia/Kolkata"), "Asia/Kolkata"), 18);
    // The wrap-up may happen at 02:00; it survives the night.
    assert.strictEqual(hourIn(goodNightFlow.computeExpiry("Asia/Kolkata"), "Asia/Kolkata"), 10);
    assert.ok(goodNightFlow.computeExpiry("Asia/Kolkata") > goodMorningFlow.computeExpiry("Asia/Kolkata"));

    // Cutoffs are the USER'S wall clock, not the server's.
    assert.strictEqual(hourIn(goodMorningFlow.computeExpiry("America/New_York"), "America/New_York"), 18);
    assert.notStrictEqual(
        goodMorningFlow.computeExpiry("Asia/Kolkata").getTime(),
        goodMorningFlow.computeExpiry("America/New_York").getTime()
    );

    assert.ok(!("ttlMinutes" in goodMorningFlow), "fixed TTL must be gone");
    assert.ok(!("ttlMinutes" in goodNightFlow), "fixed TTL must be gone");
});

test("the morning job is what ends the night flow", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../scheduler/jobs/goodMorningJob.js", import.meta.url), "utf8");
    assert.match(src, /closeFlow\(/, "morning job must close the night flow");
    assert.ok(src.indexOf("closeFlow(") < src.indexOf("openFlow("),
        "close the night flow BEFORE opening the morning one");
});

test("two-strike rule is stated and its state is visible to the model", async () => {
    const { goodMorningFlow } = await import("../agent/flows/goodMorningFlow.js");
    const { flowStateBlock } = await import("../agent/agent.js");

    assert.match(goodMorningFlow.instruction, /FIRST unrelated message/);
    assert.match(goodMorningFlow.instruction, /SECOND unrelated message/);
    assert.match(goodMorningFlow.instruction, /updateFlowScratchpad/);

    // The rule reads unrelatedReplies, so it must reach the prompt — otherwise
    // the scratchpad is write-only and the second strike never fires.
    assert.match(flowStateBlock({ flowType: "goodMorning", scratchpad: { unrelatedReplies: 1 } }),
        /unrelatedReplies so far: 1/);
    assert.match(flowStateBlock({ flowType: "goodMorning" }), /unrelatedReplies so far: 0/);
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
