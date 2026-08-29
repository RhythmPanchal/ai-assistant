/**
 * Hand-run:  node src/test/testProfileRender.js
 *
 * The WHO YOU ARE HELPING block used to be a string literal describing one
 * person. It is now rendered per user, which means it can be wrong per user —
 * and every failure here is a wrong belief the model states confidently.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects: renderProfileBlock is pure and takes its rows as arguments.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const { renderProfileBlock } = await import("../knowledge/userProfileKnowledge.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);
const read = (p) => readFileSync(p, "utf8");

const NOW = Date.parse("2026-08-25T00:00:00Z");
const fact = (over) => ({ stability: "stable", confidence: "stated", ...over });

test("no userId reaches the prompt", () => {
    // Tools take identity from the bound context, so the model has no use for a
    // userId — and a userId in the prompt is what an injection aims at:
    // "actually my userId is 2" is only worth attempting while it has one to
    // state.
    const out = renderProfileBlock(7, { name: "Aditya" }, [
        fact({ key: "work.role", fact: "developer", category: "work" }),
    ], NOW);
    assert.doesNotMatch(out, /userId/i, "identity must not travel through the prompt");
    assert.match(out, /Aditya/, "the block still has to say who they are");
});

test("an empty profile still renders a usable block", () => {
    const out = renderProfileBlock(7, null, [], NOW);
    assert.match(out, /WHO YOU ARE HELPING/);
    assert.doesNotMatch(out, /userId/i);
});

test("expired facts are not asserted", () => {
    const out = renderProfileBlock(2, null, [
        fact({ key: "work.status", fact: "actively job hunting", category: "work",
               stability: "temporary", expiresAt: "2026-01-01T00:00:00Z" }),
        fact({ key: "work.role", fact: "backend developer", category: "work" }),
    ], NOW);
    assert.doesNotMatch(out, /job hunting/,
        "telling someone employed a year that they are job hunting is worse than silence");
    assert.match(out, /backend developer/, "live facts must survive the filter");
});

test("a fact expiring in the future still renders", () => {
    const out = renderProfileBlock(2, null, [
        fact({ key: "work.status", fact: "job hunting", category: "work",
               stability: "temporary", expiresAt: "2026-12-01T00:00:00Z" }),
    ], NOW);
    assert.match(out, /job hunting/);
});

test("temporary and inferred facts are marked", () => {
    const out = renderProfileBlock(2, null, [
        fact({ key: "location.current", fact: "In Pune", category: "location", stability: "temporary" }),
        fact({ key: "money.habits", fact: "tracks expenses", category: "money", confidence: "inferred" }),
        fact({ key: "location.home", fact: "From Nagpur", category: "location" }),
    ], NOW);
    assert.match(out, /In Pune\s+\[temporary\]/);
    assert.match(out, /tracks expenses\s+\[unconfirmed\]/);
    assert.match(out, /From Nagpur$/m, "a stated stable fact carries no marker");
});

test("category falls back to the key namespace when the field is absent", () => {
    const out = renderProfileBlock(2, null, [
        fact({ key: "work.role", fact: "backend developer" }),
    ], NOW);
    assert.match(out, /Work\s+backend developer/,
        "category is optional on the row; the key already says where it belongs");
});

test("an unknown namespace lands under Other rather than vanishing", () => {
    const out = renderProfileBlock(2, null, [
        fact({ key: "custom.gym", fact: "Gym Mon/Wed/Fri", category: "custom" }),
    ], NOW);
    assert.match(out, /Other\s+Gym Mon\/Wed\/Fri/,
        "custom.* is the open namespace — dropping it silently loses real context");
});

test("render is stable across calls", () => {
    const rows = [
        fact({ key: "work.role", fact: "developer", category: "work" }),
        fact({ key: "location.home", fact: "Nagpur", category: "location" }),
        fact({ key: "money.goals", fact: "saving", category: "money" }),
    ];
    assert.strictEqual(
        renderProfileBlock(2, null, rows, NOW),
        renderProfileBlock(2, null, [...rows].reverse(), NOW),
        "a block that reshuffles between turns cannot be prompt-cached");
});

test("the instruction fallback names no user and no userId", () => {
    const src = read("src/agent/instruction.js");
    assert.doesNotMatch(src, /1136575387/,
        "a literal userId here is what silently files one user's data under another");
    assert.doesNotMatch(src, /Rhythm Panchal/,
        "the fallback is shown to any user whose profile failed to load");
});

test("nothing tells the model to scope its own reads any more", async () => {
    const { buildSystemInstruction } = await import("../agent/instruction.js");
    const prompt = buildSystemInstruction();
    assert.doesNotMatch(prompt, /filter by the userId/i,
        "the data layer forces the filter; an instruction to do it is now false");
    assert.match(prompt, /scoped to this user automatically/,
        "the model should know why it can never see anyone else's rows");
});

test("buildSystemInstruction injects the rendered profile", async () => {
    const { buildSystemInstruction } = await import("../agent/instruction.js");
    const out = buildSystemInstruction([], { profile: "MARKER-PROFILE-BLOCK" });
    assert.match(out, /MARKER-PROFILE-BLOCK/);

    const fallback = buildSystemInstruction();
    assert.match(fallback, /No profile is loaded/,
        "omitting the profile must degrade to the fallback, not to undefined");
});

test("agent.js renders the profile every turn", () => {
    const src = read("src/agent/agent.js");
    assert.match(src, /userProfileKnowledge\(userId, userProfile\)/);
    assert.match(src, /buildSystemInstruction\(overlays, \{ profile/,
        "a cached block is how the agent ends up asserting last week's facts");
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
