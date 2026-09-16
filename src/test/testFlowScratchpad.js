/**
 * Hand-run:  node src/test/testFlowScratchpad.js
 *
 * The scratchpad is merged, not replaced. Writes to Rasmalai-eval under a
 * throwaway userId and deletes what it made; never touches the database .env
 * names.
 *
 * The regression being pinned: updateFlowScratchpad used $set on the whole
 * object, so saving one key erased every other one. Nothing noticed while
 * unrelatedReplies was the only key in use.
 */
import "dotenv/config";
import assert from "node:assert";

process.env.MONGODB_DB_NAME = "Rasmalai-eval";

const { getDB } = await import("../tools/mongo/mongoClient.js");
const { openFlow } = await import("../scheduler/flows/activeFlowsRepo.js");
const { UpdateFlowScratchpadTool } = await import("../agent/tools/definitions/UpdateFlowScratchpadTool.js");

const USER = 900002;
const db = await getDB();
if (/prod/i.test(db.databaseName)) throw new Error(`refusing to write to ${db.databaseName}`);

const tool = new UpdateFlowScratchpadTool();
const saved = async () => (await db.collection("activeFlows").findOne({ userId: USER, state: "open" }))?.scratchpad;
const cleanup = () => db.collection("activeFlows").deleteMany({ userId: USER });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("a first write lands on a flow opened with scratchpad: null", async () => {
    const r = await tool.execute({ userId: USER, flowType: "goodNight", scratchpad: { nothingToLog: ["expenses"] } });
    assert.ok(r.success, r.message);
    assert.deepStrictEqual(await saved(), { nothingToLog: ["expenses"] });
});

test("a second key does not erase the first", async () => {
    await tool.execute({ userId: USER, flowType: "goodNight", scratchpad: { unrelatedReplies: 1 } });
    assert.deepStrictEqual(await saved(), { nothingToLog: ["expenses"], unrelatedReplies: 1 });
});

test("re-sending a key replaces that key only", async () => {
    await tool.execute({ userId: USER, flowType: "goodNight", scratchpad: { nothingToLog: ["expenses", "tasks"] } });
    assert.deepStrictEqual(await saved(), { nothingToLog: ["expenses", "tasks"], unrelatedReplies: 1 });
});

test("the result carries the whole merged state, not just what was sent", async () => {
    const r = await tool.execute({ userId: USER, flowType: "goodNight", scratchpad: { unrelatedReplies: 2 } });
    assert.deepStrictEqual(r.data.scratchpad, { nothingToLog: ["expenses", "tasks"], unrelatedReplies: 2 });
});

test("a value starting with $ is stored as text, not read as a field path", async () => {
    await tool.execute({ userId: USER, flowType: "goodNight", scratchpad: { note: "$scratchpad" } });
    assert.strictEqual((await saved()).note, "$scratchpad");
});

test("a non-object is refused without writing", async () => {
    const before = await saved();
    for (const bad of [null, [1, 2], "x"]) {
        const r = await tool.execute({ userId: USER, flowType: "goodNight", scratchpad: bad });
        assert.strictEqual(r.success, false, `accepted ${JSON.stringify(bad)}`);
    }
    assert.deepStrictEqual(await saved(), before);
});

test("no open flow of that type is reported, not silently ignored", async () => {
    const r = await tool.execute({ userId: USER, flowType: "goodMorning", scratchpad: { a: 1 } });
    assert.strictEqual(r.success, false);
});

await cleanup();
await openFlow({ userId: USER, flowType: "goodNight", ttlMinutes: 10 });

let pass = 0;
try {
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`PASS  ${name}`); }
        catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
    }
} finally {
    await cleanup();
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
