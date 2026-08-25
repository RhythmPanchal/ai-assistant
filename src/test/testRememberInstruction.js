/**
 * Hand-run:  node src/test/testRememberInstruction.js
 *
 * rememberFact has been callable since it was registered and userFact is still
 * empty in production, because nothing in the prompt told the model the tool
 * existed. This guards the instruction that fixes that — and the two properties
 * that keep it from causing the failure §7 records, where always-on ceremony
 * made the model announce work it had not done.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects.
 */
import "dotenv/config";
import assert from "node:assert";

const { buildSystemInstruction } = await import("../agent/instruction.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;

const tests = [];
const test = (n, f) => tests.push([n, f]);
const prompt = buildSystemInstruction();

test("the base prompt names rememberFact", () => {
    assert.match(prompt, /rememberFact/,
        "a tool the prompt never mentions is a tool the model never reaches for");
});

test("the tool it names is actually registered", () => {
    // A prompt referring to a tool that is not in the registry earns a refusal
    // under HARD RULE 5, which forbids calling anything outside the tool list.
    assert.ok(toolRegistry.getTool("rememberFact"),
        "instruction and registry must agree or the model is told to do the impossible");
});

test("identity is separated from events by example, not by definition", () => {
    // The distinction that matters is I AM vs I DID. Abstract wording did not
    // hold in the flow overlays; concrete pairs did.
    assert.match(prompt, /vegetarian/);
    assert.match(prompt, /dietRegister/);
    assert.match(prompt, /moved to Pune/);
    assert.match(prompt, /expenseRegister/);
});

test("recording is silent", () => {
    assert.match(prompt, /SILENTLY/,
        "narrating every save turns a conversation into an interview");
    assert.match(prompt, /No "noted"/);
});

test("the tools-before-text rule is not weakened", () => {
    // §7: always-on ceremony rules caused the model to claim writes it never
    // made. This section is exactly that shape, so it must defer to rule 1.
    assert.match(prompt, /HARD RULE 1 still applies/);
    assert.match(prompt, /NEVER claim an action is done before the tool call returned/,
        "rule 1 itself must survive any edit to the section that leans on it");
});

test("facts are batched, not written one call at a time", () => {
    assert.match(prompt, /one call rather than calling repeatedly/,
        "maxSteps is 20 and one fact per call burns the budget on a single message");
});

test("the section sits with the other write-on-mention behaviour", () => {
    const passing = prompt.indexOf("CATCHING THINGS MENTIONED IN PASSING");
    const remember = prompt.indexOf("REMEMBERING WHO THEY ARE");
    const reading = prompt.indexOf("READING DATA");
    assert.ok(passing > 0 && remember > passing && remember < reading,
        "both sections answer 'the user just said something — write it where?'");
});

test("it lives in DEFAULTS, which an overlay may override", () => {
    const defaults = prompt.indexOf("DEFAULT BEHAVIOUR");
    const remember = prompt.indexOf("REMEMBERING WHO THEY ARE");
    assert.ok(defaults > 0 && remember > defaults,
        "onboarding and enrichment need to restate this; a HARD RULE could not be overridden");
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
