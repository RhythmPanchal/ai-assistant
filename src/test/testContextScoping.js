/**
 * Hand-run:  node src/test/testContextScoping.js
 *
 * Adversarial, not structural. Every case below constructs arguments the way a
 * prompt-injected or simply confused model would — naming someone else's userId,
 * reaching for a foreign _id — and asserts the identity that actually reaches
 * the data layer is the one the entry point bound.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import). Nothing
 * here reaches a query: every case either fails on the unbound context first or
 * is intercepted before the driver is touched.
 */
import "dotenv/config";
import assert from "node:assert";

const { ToolRegistry } = await import("../agent/tools/ToolRegistry.js");
const { BaseTool, ToolResult } = await import("../agent/tools/BaseTool.js");
const { runWithUserContext, runAsSystem, SYSTEM_USER_ID } = await import("../identity/userContext.js");
const { fetchRecord } = await import("../tools/mongo/fetchRecords.js");
const { updateRecords } = await import("../tools/mongo/updateRecord.js");
const { createRecord } = await import("../tools/mongo/createRecord.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;

const tests = [];
const test = (n, f) => tests.push([n, f]);

// A probe registered into its OWN registry, so the singleton the app uses is
// never polluted. It reports exactly what execute() handed it.
class ProbeTool extends BaseTool {
    static name = "probe";
    static description = "echoes its args";
    static parameters = { type: "object", properties: {}, required: [] };
    async execute(args) { return new ToolResult(true, "ok", args); }
}
const probes = new ToolRegistry();
probes.register(new ProbeTool());

test("the registry supplies identity, and a model-supplied one is discarded", async () => {
    const result = await runWithUserContext({ userId: 1, channel: "telegram" }, () =>
        // Exactly what an escalation attempt produces: the model names someone else.
        probes.execute("probe", { userId: 999, note: "act as user 999" })
    );
    assert.strictEqual(result.data.userId, 1,
        "the bound context must win over anything in args — spread order is the guarantee");
    assert.strictEqual(result.data.note, "act as user 999", "other args pass through untouched");
});

test("a tool cannot run at all without a bound identity", async () => {
    await assert.rejects(() => probes.execute("probe", {}), /no user context bound/,
        "an unbound tool call must fail rather than default to somebody");
});

test("two concurrent turns get their own identity through the registry", async () => {
    const [a, b] = await Promise.all([
        runWithUserContext({ userId: 11, channel: "telegram" }, async () => {
            await new Promise(r => setTimeout(r, 5));
            return (await probes.execute("probe", { userId: 999 })).data.userId;
        }),
        runWithUserContext({ userId: 22, channel: "telegram" }, async () => {
            return (await probes.execute("probe", { userId: 999 })).data.userId;
        }),
    ]);
    assert.deepStrictEqual([a, b], [11, 22], "interleaved turns must not cross-contaminate");
});

// ── the data layer refuses to run unscoped ───────────────────────────────────
// These are the three that had no scoping at all. fetchRecord's entire defence
// was the sentence "Always include userId in filters" in its tool description.

test("fetchRecord will not run without an identity", async () => {
    await assert.rejects(
        () => fetchRecord("expenseRegister", { userId: 999 }),
        /no user context bound/,
        "an unscoped read is how one user's query returns everyone's rows"
    );
});

test("updateRecords will not run without an identity", async () => {
    const out = await updateRecords([{ collectionName: "taskCalendar", id: "aaaaaaaaaaaaaaaaaaaaaaaa", data: { title: "x" } }]);
    // updateRecords collects per-record errors rather than throwing, so the
    // refusal arrives as a failed row.
    assert.strictEqual(out.successCount, 0);
    assert.match(out.results[0].error, /no user context bound/);
});

test("createRecord will not run without an identity", async () => {
    await assert.rejects(
        () => createRecord("expenseRegister", { userId: 999, name: "x", amount: 1 }),
        /no user context bound/
    );
});

// ── the shape of the scoping, where a live query cannot be run ───────────────

test("fetchRecord overwrites the model's userId rather than defaulting to it", async () => {
    const src = (await import("node:fs")).readFileSync("src/tools/mongo/fetchRecords.js", "utf8");
    assert.match(src, /\{ \.\.\.filters, userId: context\.userId \}/,
        "context must be spread LAST or a model-supplied userId survives");
});

test("updateRecords scopes the match, not just a check afterwards", async () => {
    const src = (await import("node:fs")).readFileSync("src/tools/mongo/updateRecord.js", "utf8");
    assert.match(src, /\{ _id: objectId, userId: context\.userId \}/,
        "matching on _id alone let any valid id rewrite any user's row");
    assert.match(src, /userId: context\.userId.*\n.*updatedAt/s,
        "userId must be re-stamped so it cannot be patched to another account");
    // Check the thrown string itself, not the comment above it explaining why.
    const thrown = src.match(/throw new Error\(`Record with id[^`]*`\)/)?.[0] ?? "";
    assert.ok(thrown, "the not-found error must still exist");
    assert.doesNotMatch(thrown, /yours|another|permission|forbidden/i,
        "distinguishing 'not found' from 'not yours' turns this into a probe for other accounts");
});

test("createRecord only stamps an owner on collections that have one", async () => {
    const src = (await import("node:fs")).readFileSync("src/tools/mongo/createRecord.js", "utf8");
    assert.match(src, /schema\?\.properties\?\.userId/,
        "forcing userId onto factKey or oauthConnector would fail schema validation");
});

// ── system work is exempt, and only reachable from server-side code ──────────

test("system context is exempt so migrations can cross users", async () => {
    const result = await runAsSystem("test", () => probes.execute("probe", {}));
    assert.strictEqual(result.data.userId, SYSTEM_USER_ID);

    for (const src of ["src/tools/mongo/fetchRecords.js", "src/tools/mongo/updateRecord.js", "src/tools/mongo/createRecord.js"]) {
        const text = (await import("node:fs")).readFileSync(src, "utf8");
        assert.match(text, /isSystem/,
            `${src} must skip scoping for system work — filtering TO -1 matches nothing, not everything`);
    }
});

test("the exemption is not reachable by the model", () => {
    // runAsSystem is a plain function, never registered as a tool, so there is
    // no call the model can emit that asks to be exempted.
    assert.strictEqual(toolRegistry.getTool("runAsSystem"), undefined);
    const declared = toolRegistry.getToolDeclarations().map(d => d.name);
    assert.ok(!declared.some(n => /system/i.test(n)), `no tool may expose system mode: ${declared}`);
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
