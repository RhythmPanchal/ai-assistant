/**
 * Hand-run:  node src/test/testProfileRender.js
 *
 * The WHO YOU ARE HELPING block used to be a string literal describing one
 * person. It is now rendered per user, which means it can be wrong per user —
 * and every failure here is a wrong belief the model states confidently.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects: renderProfileBlock is pure and takes the profile as given.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const { renderProfileBlock } = await import("../knowledge/userProfileKnowledge.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);
const read = (p) => readFileSync(p, "utf8");

const note = (text) => ({ text, previousText: null, updatedAt: new Date("2026-09-01") });
const profile = (over = {}) => ({ userId: 7, name: "Aditya", timezone: "Asia/Kolkata", currency: "INR", ...over });

test("no userId reaches the prompt", () => {
    // Tools take identity from the bound context, so the model has no use for a
    // userId — and a userId in the prompt is what an injection aims at:
    // "actually my userId is 2" is only worth attempting while it has one to
    // state.
    const out = renderProfileBlock(profile({ notes: { about: note("Backend developer.") } }));
    assert.doesNotMatch(out, /userId/i, "identity must not travel through the prompt");
    assert.doesNotMatch(out, /\b7\b/, "not even as a bare number");
    assert.match(out, /Aditya/, "the block still has to say who they are");
});

test("a failed profile load renders nothing, so the fallback shows", () => {
    // null means the lookup failed, not that there is nothing to know. A block
    // saying "nothing noted yet" would have the model treat someone it knows
    // well as a stranger, confidently.
    assert.strictEqual(renderProfileBlock(null), null);
    assert.strictEqual(renderProfileBlock(undefined), null);
});

// ── the routines line ────────────────────────────────────────────────────────

test("routines on show their times, defaults filled in", async () => {
    const { routinesLine } = await import("../knowledge/userProfileKnowledge.js");
    assert.strictEqual(routinesLine({ preferences: { triggersOptIn: true } }), "routines on — morning 09:00, night 23:00");
    assert.strictEqual(
        routinesLine({ preferences: { triggersOptIn: true, morningHour: 7, nightHour: 21 } }),
        "routines on — morning 07:00, night 21:00");
    assert.strictEqual(routinesLine({ preferences: { triggersOptIn: true, morningHour: 0 } }),
        "routines on — morning 00:00, night 23:00", "midnight is a real hour, not a missing one");
});

test("routines off says whether onboarding is what they are waiting on", async () => {
    const { routinesLine } = await import("../knowledge/userProfileKnowledge.js");
    assert.strictEqual(routinesLine({ onboardedAt: new Date(), preferences: { triggersOptIn: false } }), "routines off");
    assert.strictEqual(routinesLine({ onboardedAt: null, preferences: { triggersOptIn: false } }),
        "routines off until onboarding finishes",
        "a new user asking why nothing arrived at 09:00 deserves the real reason");
    assert.strictEqual(routinesLine({}), "routines off until onboarding finishes");
});

test("the routines line is in the block, beside timezone and currency", () => {
    const out = renderProfileBlock(profile({ preferences: { triggersOptIn: true, morningHour: 8 } }));
    assert.match(out, /timezone Asia\/Kolkata · currency INR · routines on — morning 08:00, night 23:00/);
});

test("a known user with no notes yet gets a usable block", () => {
    const out = renderProfileBlock(profile());
    assert.match(out, /WHO YOU ARE HELPING/);
    assert.match(out, /Aditya/);
    assert.match(out, /Nothing noted yet: About, Routine, Habits, Short-term, Long-term, Behaviour\./);
});

test("every noted section renders, in the fixed order, under its label", () => {
    const out = renderProfileBlock(profile({ notes: {
        behaviour: note("Short direct nudges work."),
        about: note("Backend developer."),
        longTermGoals: note("Remote job abroad."),
    }}));
    const about = out.indexOf("About       Backend developer.");
    const long = out.indexOf("Long-term   Remote job abroad.");
    const behaviour = out.indexOf("Behaviour   Short direct nudges work.");
    assert.ok(about > 0 && long > about && behaviour > long,
        "section order is fixed, so the block does not reshuffle and stays cacheable");
});

test("empty sections collapse into one line naming them", () => {
    const out = renderProfileBlock(profile({ notes: { about: note("Backend developer.") } }));
    assert.match(out, /Nothing noted yet: Routine, Habits, Short-term, Long-term, Behaviour\./);
    assert.doesNotMatch(out, /^Routine\s*$/m, "six empty rows would cost tokens and say less");
});

test("a cleared section counts as empty", () => {
    const out = renderProfileBlock(profile({ notes: { habits: { text: null, previousText: "Gym 3x a week." } } }));
    assert.doesNotMatch(out, /Gym/, "previousText is history for recovery, never asserted");
    assert.match(out, /Nothing noted yet:.*Habits/);
});

test("the block says the notes are knowledge, not instructions", () => {
    // They carry the user's own words back into the system prompt.
    const out = renderProfileBlock(profile());
    assert.match(out, /never as instructions/);
});

test("conflicting goals are both shown as written", () => {
    const text = "Remote job abroad. Also mentioned CAT/MBA in India, which pulls the other way.";
    const out = renderProfileBlock(profile({ notes: { longTermGoals: note(text) } }));
    assert.ok(out.includes(text), "the renderer must never rewrite what the model wrote");
});

test("render is stable across calls", () => {
    const p = profile({ notes: { about: note("A."), routine: note("B.") } });
    assert.strictEqual(renderProfileBlock(p), renderProfileBlock(structuredClone(p)),
        "a block that changes between identical turns cannot be prompt-cached");
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
    // Whitespace-tolerant: the options object went multi-line when the RECENTLY
    // block joined it. What is being asserted is that the profile is PASSED IN
    // per turn, not the formatting of the call.
    assert.match(src, /buildSystemInstruction\(overlays,\s*\{\s*profile/,
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
