/**
 * Hand-run:  node src/test/testRememberInstruction.js
 *
 * The REMEMBERING WHO THEY ARE section is the only thing that tells the model
 * its notes exist and how to keep them. A tool the prompt never mentions is a
 * tool the model never reaches for — the fact store sat empty in production for
 * exactly that reason. This guards the section, and the properties that stop it
 * from causing the failure §7 records, where always-on ceremony made the model
 * announce work it had not done.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects.
 */
import "dotenv/config";
import assert from "node:assert";

const { buildSystemInstruction } = await import("../agent/instruction.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;
const { NOTE_SECTIONS } = await import("../tools/mongo/schema/usersSchema.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);
const prompt = buildSystemInstruction();
const section = prompt.slice(prompt.indexOf("REMEMBERING WHO THEY ARE"), prompt.indexOf("READING DATA"));

test("the base prompt names updateNotes", () => {
    assert.match(section, /updateNotes/,
        "a tool the prompt never mentions is a tool the model never reaches for");
});

test("the tool it names is registered and declared", () => {
    // HARD RULE 5 forbids calling anything outside the tool list, so a prompt
    // naming an undeclared tool tells the model to do the impossible.
    assert.ok(toolRegistry.getTool("updateNotes"));
    assert.ok(toolRegistry.isDeclared("updateNotes"),
        "notes are written mid-conversation; they cannot wait for a skill to load");
});

test("no tool that no longer exists is named anywhere in the prompt", () => {
    for (const gone of ["rememberFact", "fetchUserContext", "forgetFact", "manageFactKey"]) {
        assert.doesNotMatch(prompt, new RegExp(gone), `${gone} was removed; naming it earns a refusal`);
    }
});

test("every section a routing example names is a real one", () => {
    // The examples say which section; a typo there teaches the model a section
    // name the write will refuse.
    const real = new Set(NOTE_SECTIONS.map(s => s.key));
    // Only the arrow form: "-> updateNotes  habits". The prose around it also
    // says updateNotes, followed by ordinary words.
    const named = [...section.matchAll(/->\s*updateNotes\s+(\w+)/g)].map(m => m[1]);
    assert.ok(named.length >= 5, "the examples should route to specific sections");
    for (const name of named) assert.ok(real.has(name), `"${name}" is not a notes section`);
});

test("goals and habits are routed, not just facts", () => {
    for (const s of ["habits", "shortTermGoals", "longTermGoals", "routine"]) {
        assert.match(section, new RegExp(`->\\s*updateNotes\\s+${s}\\b`), `nothing shows the model what goes in ${s}`);
    }
});

test("who they are is separated from what happened, by example", () => {
    // The distinction that matters is I AM vs I DID. Abstract wording did not
    // hold in the flow overlays; concrete pairs did.
    assert.match(section, /vegetarian/);
    // Food goes through addMeal, never createRecord on dietRegister — the
    // CATCHING block forbids that path, so the example must not point at it.
    assert.match(section, /addMeal/);
    assert.doesNotMatch(section, /-> dietRegister/);
    assert.match(section, /moved to Pune/);
    assert.match(section, /expenseRegister/);
});

test("replace-only is stated, since the model writes whole sections", () => {
    assert.match(section, /REPLACES/, "a model that appends wipes everything else in the section");
});

test("a conflicting goal is kept and named, not resolved silently", () => {
    assert.match(section, /keep\s+both/);
});

test("drift from a goal is named in one line, then the request is done anyway", () => {
    // Stated abstractly ("say so once, in passing"), the live eval showed the
    // model scheduling work that pulled away from a goal without a word. The
    // concrete pairs are what it follows.
    assert.match(section, /HOLDING THEM TO WHAT THEY SAID/);
    assert.match(section, /say so in ONE line — then do what they asked/,
        "raising a goal must never become refusing the request");
    assert.ok((section.match(/^\s+-> "/gm) || []).length >= 2, "at least two worked examples");
});

test("the goal nudge is never an opener and never repeated", () => {
    assert.match(section, /Once per topic, never as an opener, and never a lecture/,
        "a reminder at the top of every chat is nagging, which the user asked not to get");
});

test("its examples do not reuse what the live eval grades", () => {
    // A pass on a phrase the prompt already contains could be the model
    // copying the example back rather than applying the rule.
    const holding = section.slice(section.indexOf("HOLDING THEM TO WHAT THEY SAID"));
    for (const graded of [/rust/i, /react/i, /canada/i, /rasmalai/i]) {
        assert.doesNotMatch(holding, graded);
    }
});

test("settings are sent to the skill, not written as notes", () => {
    assert.match(section, /timezone/);
    assert.match(section, /userContextEnrichment/);
});

test("recording is silent", () => {
    assert.match(prompt, /SILENTLY/, "narrating every save turns a conversation into an interview");
    assert.match(prompt, /No "noted"/);
});

test("the tools-before-text rule is not weakened", () => {
    assert.match(prompt, /HARD RULE 1 still applies/);
    assert.match(prompt, /NEVER claim an action is done before the tool call returned/,
        "rule 1 itself must survive any edit to the section that leans on it");
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
        "a routine needs to be able to restate this; a HARD RULE could not be overridden");
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
