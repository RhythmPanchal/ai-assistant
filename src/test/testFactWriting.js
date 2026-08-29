/**
 * Hand-run:  node src/test/testFactWriting.js
 *
 * The fact store is the only thing the model writes that then shapes every
 * later prompt, so a bad write is not one wrong row — it is a wrong belief
 * repeated in every future conversation until someone notices.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects: everything here is either pure or rejected before the first
 * database call.
 */
import "dotenv/config";
import assert from "node:assert";

const { normalizeFact, rememberFacts } = await import("../tools/mongo/operation/userFacts.js");
const { CORE_FACT_KEYS, KEY_PATTERN, PROMOTION_THRESHOLD } = await import("../tools/mongo/schema/factKeySchema.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("well-formed keys are accepted and lowercased", () => {
    assert.strictEqual(normalizeFact({ key: "work.status", fact: "job hunting" }).key, "work.status");
    assert.strictEqual(normalizeFact({ key: "  Work.Status  ", fact: "x" }).key, "work.status",
        "Work.Status and work.status are one concept the vocabulary cannot merge after the fact");
    assert.ok(normalizeFact({ key: "custom.gym", fact: "Mon/Wed/Fri" }).ok,
        "custom.* is the open namespace and must stay writable");
    assert.ok(normalizeFact({ key: "education.certification", fact: "CA finals" }).ok,
        "an invented key is the whole point — it gets minted as emergent");
});

test("malformed keys are rejected with a usable reason", () => {
    for (const key of ["workstatus", "work_status", "work.", ".work", "Work Status", ""]) {
        const r = normalizeFact({ key, fact: "x" });
        assert.strictEqual(r.ok, false, `"${key}" must not be accepted`);
        assert.match(r.reason, /work\.status/, "the reason must show the shape the model should use");
    }
});

test("an empty fact is rejected even under a valid key", () => {
    const r = normalizeFact({ key: "work.status", fact: "   " });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /empty/);
});

test("rememberFacts refuses a non-integer userId before touching the database", async () => {
    await assert.rejects(() => rememberFacts("2", [{ key: "work.status", fact: "x" }]), /integer/);
    await assert.rejects(() => rememberFacts(null, [{ key: "work.status", fact: "x" }]), /integer/);
});

test("an empty batch is a no-op, not a connection", async () => {
    assert.deepStrictEqual(await rememberFacts(2, []), { saved: [], rejected: [] });
});

test("every core key is valid under the pattern it will be written with", () => {
    const bad = Object.keys(CORE_FACT_KEYS).filter(k => !KEY_PATTERN.test(k));
    assert.deepStrictEqual(bad, [], "a core key failing the pattern makes the boot seed write rows the validator rejects");
    assert.ok(Object.keys(CORE_FACT_KEYS).length >= 12, "the seeded spine should cover the common shape of a person");
});

test("promotion needs more than one person", () => {
    assert.ok(PROMOTION_THRESHOLD >= 2,
        "a threshold of 1 promotes one user's idiosyncrasy into everyone's onboarding questions");
});

test("rememberFact is exposed to the model and correctly shaped", () => {
    const tool = toolRegistry.getTool("rememberFact");
    assert.ok(tool, "the model cannot record anything about the user without this");

    const d = tool.toFunctionDeclaration();
    // userId is absent by design — the registry supplies it from the bound
    // context, so the model cannot choose whose profile it writes to.
    assert.deepStrictEqual(d.parameters.required, ["facts"]);
    assert.ok(!("userId" in d.parameters.properties), "userId must not be model-supplied");
    assert.strictEqual(d.parameters.properties.facts.type, "array",
        "batching matters: onboarding learns several things in one message");
    assert.deepStrictEqual(d.parameters.properties.facts.items.required, ["key", "fact"],
        "stability and confidence must stay optional or the model will omit the fact to satisfy them");

    // The description is the only thing steering when it fires; without the
    // contrast the model logs 'spent 200 on lunch' as a fact about the person.
    assert.match(d.description, /expense|meal|task/i);
});

test("the model can write facts but cannot query them back", async () => {
    const { USER_FACT } = await import("../tools/mongo/schema/userFactSchema.js");
    const src = (await import("node:fs")).readFileSync("src/tools/mongo/fetchRecords.js", "utf8");
    assert.doesNotMatch(src, new RegExp(`\\b${USER_FACT}\\b`),
        "userFact in the read whitelist is how invented keys and cross-user reads start");
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
