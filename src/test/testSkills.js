/**
 * Hand-run:  node src/test/testSkills.js
 *
 * A skill widens a turn: it appends to the system message and adds tool
 * declarations partway through the agent loop. The properties that matter are
 * that it takes effect in the SAME reply, that it cannot advertise a tool the
 * registry cannot run, and that it costs nothing on the turns that never load it.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const { SKILLS, SKILL_NAMES, allSkillToolNames, skillCatalogue } = await import("../agent/skills/index.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;
const { buildSystemInstruction } = await import("../agent/instruction.js");
const { runWithUserContext } = await import("../identity/userContext.js");

// toolRegistry.execute now reads identity from the bound context and throws
// without one — that is the point. Tests have to say who they are.
const asUser = (fn) => runWithUserContext({ userId: 1, channel: "test" }, fn);

const tests = [];
const test = (n, f) => tests.push([n, f]);
const agentSrc = readFileSync("src/agent/agent.js", "utf8");

test("every tool a skill names is registered and runnable", () => {
    // index.js throws at boot on a mismatch; this states why that matters.
    for (const name of allSkillToolNames()) {
        assert.ok(toolRegistry.getTool(name),
            `${name} is advertised by a skill but execute() could not find it — every call would fail`);
    }
});

test("skill tools are executable but not advertised", () => {
    const declared = toolRegistry.getToolDeclarations().map(d => d.name);
    for (const name of allSkillToolNames()) {
        assert.ok(!declared.includes(name),
            `${name} in the default declarations defeats the point — every request would pay for it`);
    }
    assert.ok(declared.includes("loadSkill"), "the model needs one always-present way in");
});

test("a skill's declarations can be fetched on demand", () => {
    const skill = SKILLS.userContextEnrichment;
    const declarations = toolRegistry.getDeclarationsFor(skill.toolNames);
    assert.strictEqual(declarations.length, skill.toolNames.length);
    assert.deepStrictEqual(declarations.map(d => d.name).sort(), [...skill.toolNames].sort());
});

test("an unknown tool name is skipped, not thrown", () => {
    // A skill outliving one of its tools should lose that tool, not break turns.
    const declarations = toolRegistry.getDeclarationsFor(["forgetFact", "toolThatWasDeleted"]);
    assert.deepStrictEqual(declarations.map(d => d.name), ["forgetFact"]);
});

test("the unknown-tool error does not leak undeclared tool names", async () => {
    const result = await asUser(() => toolRegistry.execute("noSuchTool", {}));
    assert.strictEqual(result.success, false);
    for (const hidden of allSkillToolNames()) {
        assert.ok(!result.message.includes(hidden),
            `naming ${hidden} here invites the model to call something it was never offered`);
    }
});

test("loadSkill returns what the loop needs to widen the turn", async () => {
    const result = await asUser(() => toolRegistry.execute("loadSkill", { skill: "userContextEnrichment" }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.skill, "userContextEnrichment");
    assert.ok(result.data.instruction?.length > 200, "the instruction is the substance of a skill");
    assert.deepStrictEqual(result.data.toolNames, SKILLS.userContextEnrichment.toolNames);
});

test("an unknown skill fails without pretending to load", async () => {
    const result = await asUser(() => toolRegistry.execute("loadSkill", { skill: "nope" }));
    assert.strictEqual(result.success, false);
    assert.match(result.message, /Available/);
});

// ── the apply step, exercised rather than grepped ────────────────────────────

const { applyLoadedSkills } = await import("../agent/agent.js");

const loadResult = (skill = "userContextEnrichment", success = true) => ({
    name: "loadSkill",
    result: {
        success,
        data: success
            ? { skill, instruction: SKILLS[skill]?.instruction, toolNames: SKILLS[skill]?.toolNames }
            : {},
    },
});

const freshTurn = () => ({
    messages: [{ role: "system", content: "BASE PROMPT" }],
    toolDeclarations: toolRegistry.getToolDeclarations(),
    loadedSkills: new Set(),
});

test("applying a skill widens the tools and appends the instruction", () => {
    const turn = freshTurn();
    const before = turn.toolDeclarations.length;

    const after = applyLoadedSkills([loadResult()], turn);

    assert.strictEqual(after.length, before + SKILLS.userContextEnrichment.toolNames.length);
    for (const name of SKILLS.userContextEnrichment.toolNames) {
        assert.ok(after.some(d => d.name === name), `${name} must now be callable`);
    }
    assert.match(turn.messages[0].content, /^BASE PROMPT/, "the base prompt must survive");
    assert.match(turn.messages[0].content, /SKILL — USER CONTEXT ENRICHMENT/);
});

test("applying the same skill twice changes nothing the second time", () => {
    const turn = freshTurn();
    const once = applyLoadedSkills([loadResult()], turn);
    const contentAfterFirst = turn.messages[0].content;

    const twice = applyLoadedSkills([loadResult()], { ...turn, toolDeclarations: once });

    assert.strictEqual(twice.length, once.length, "no duplicate declarations");
    assert.strictEqual(turn.messages[0].content, contentAfterFirst, "no duplicate instruction");
});

test("a failed load leaves the turn untouched", () => {
    const turn = freshTurn();
    const after = applyLoadedSkills([loadResult("userContextEnrichment", false)], turn);
    assert.strictEqual(after.length, turn.toolDeclarations.length);
    assert.strictEqual(turn.messages[0].content, "BASE PROMPT");
    assert.strictEqual(turn.loadedSkills.size, 0);
});

test("other tool results in the same step are ignored", () => {
    const turn = freshTurn();
    const results = [
        { name: "rememberFact", result: { success: true, data: { saved: [] } } },
        { name: "fetchUserContext", result: { success: true, data: {} } },
    ];
    const after = applyLoadedSkills(results, turn);
    assert.strictEqual(after.length, turn.toolDeclarations.length);
    assert.strictEqual(turn.messages[0].content, "BASE PROMPT");
});

test("the loop applies a skill before the next request goes out", () => {
    // The ordering IS the same-reply guarantee: apply after tool results are
    // pushed, still inside the while loop, so the next iteration sees it.
    const apply = agentSrc.indexOf("applyLoadedSkills(results");
    const loopEnd = agentSrc.indexOf("if (steps >= maxSteps");
    assert.ok(apply > 0 && apply < loopEnd,
        "applying a skill outside the loop would delay it to the user's next message");

    assert.match(agentSrc, /let toolDeclarations/,
        "declarations must be reassignable or a skill cannot widen them");
    assert.match(agentSrc, /messages\[0\]\.content \+=/,
        "the skill instruction has to reach the system message");
});

test("the tool name is derived, not written twice", () => {
    assert.match(agentSrc, /LoadSkillTool\.name/,
        "a literal here drifts silently the day the wire name changes");
});

test("the base prompt points at the skill without teaching it", () => {
    const prompt = buildSystemInstruction();
    assert.match(prompt, /userContextEnrichment/, "the model must know the skill exists");
    // The procedure belongs in the skill. §7: always-on ceremony made the model
    // announce work it had not done.
    assert.ok(!prompt.includes("ALWAYS START BY READING"),
        "the skill's procedure must not leak into the base prompt");
    assert.ok(prompt.length < 12000, "base prompt should stay lean; skills exist to keep it that way");
});

test("the catalogue tells the model when to load, not what is inside", () => {
    const catalogue = skillCatalogue();
    for (const name of SKILL_NAMES) assert.ok(catalogue.includes(name));
    assert.match(catalogue, /Load when/, "a summary that omits the trigger gets loaded at random");
});

test("skills are a frozen, explicit map", () => {
    assert.ok(Object.isFrozen(SKILLS),
        "an injectable skill map is an injectable system prompt");
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
