/**
 * Hand-run:  node src/test/testOnboarding.js
 *
 * Onboarding is the first thing anyone new sees, and it is what switches their
 * routines on. Everything here that decides behaviour in CODE is pinned — the
 * mode, the welcome that is sent once, the fallback question, what finishing
 * does to routines, the idle expiry, the routing — with the model stubbed out.
 * Whether a real model actually learns the topics well is evalOnboarding's job.
 *
 * The database half runs against its own throwaway database, dropped at the
 * start and the end.
 */
import "dotenv/config";

const SCRATCH_DB = "Rasmalai-test-onboarding";
process.env.MONGODB_DB_NAME = SCRATCH_DB;

import assert from "node:assert";
import { readFileSync } from "node:fs";

const flowMod = await import("../agent/flows/onboardingFlow.js");
const { onboardingFlow, ONBOARDING_TOPICS, ONBOARDING_IDLE_MINUTES, stillEmpty, unfinishedSections, buildOnboardingContext,
    classifyReply, createSkipGuard, PLACEHOLDER, saysNothing } = flowMod;
const { NOTE_SECTIONS } = await import("../tools/mongo/schema/usersSchema.js");
const jobMod = await import("../scheduler/jobs/userOnboardingJob.js");
const { welcomeMessage, onboardingMode, neverOnboarded, composeOnboardingQuestion, userOnboardingJob, ROUTINE_FIRST_MESSAGE } = jobMod;
const { flowsForTurn, withFlowTools, resolveTask, runStepCalls, STEP_LIMIT_REPLY, WORK_DONE_REPLY } = await import("../agent/agent.js");
const { NO_REPLY } = await import("../agent/instruction.js");
const { isStartCommand } = await import("../tools/telegram/telegramHandler.js");
const { claimWelcome, markOnboarded } = await import("../tools/mongo/operation/onboarding.js");
const { completeFlow } = await import("../scheduler/flows/completeFlow.js");
const { openFlow, extendFlow, getOpenFlowsForUser } = await import("../scheduler/flows/activeFlowsRepo.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;
const { getDB } = await import("../tools/mongo/mongoClient.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);
const read = (p) => readFileSync(p, "utf8");
const MIN = 60 * 1000;

// ── the flow ─────────────────────────────────────────────────────────────────

test("twelve predefined topics, each saved to a real section or to settings", () => {
    assert.strictEqual(ONBOARDING_TOPICS.length, 12);
    const places = new Set([...NOTE_SECTIONS.map(s => s.key), "settings"]);
    for (const t of ONBOARDING_TOPICS) {
        assert.ok(places.has(t.saves), `${t.key} saves to "${t.saves}", which does not exist`);
    }
    assert.strictEqual(ONBOARDING_TOPICS[0].key, "age", "everything else branches on age, so it comes first");
    for (const section of ["about", "routine", "habits", "shortTermGoals", "longTermGoals", "behaviour"]) {
        assert.ok(ONBOARDING_TOPICS.some(t => t.saves === section), `nothing onboarding asks fills ${section}`);
    }
});

test("it expires fifteen idle minutes after the last message, not the first", () => {
    assert.strictEqual(ONBOARDING_IDLE_MINUTES, 15);
    assert.strictEqual(onboardingFlow.idleMinutes, 15);
    const now = new Date("2026-09-18T10:00:00Z");
    assert.strictEqual(onboardingFlow.computeExpiry("Asia/Kolkata", now).getTime(), now.getTime() + 15 * MIN);
});

test("settings are declared for onboarding's own turns", () => {
    assert.deepStrictEqual(onboardingFlow.toolNames, ["updateUserSettings"]);
    assert.ok(toolRegistry.getTool("updateUserSettings"), "a flow tool must be registered to be callable");
});

const instr = onboardingFlow.instruction;

test("the overlay keeps the tools-before-text rule every flow leads with", () => {
    assert.match(instr, /TOOLS BEFORE TEXT/);
    assert.match(instr, /Save silently/);
});

test("the first question is a message, not a save", () => {
    assert.match(instr, /\[onboarding\][\s\S]*Call NO tools/);
});

test("one question per message, and everything an answer gives is taken", () => {
    assert.match(instr, /ONE QUESTION PER MESSAGE/);
    // The eval caught "What are your favourite subjects, and what do you want to
    // become?" — one question mark, two asks.
    assert.match(instr, /Never two topics in one message, even joined by "and"/);
    assert.match(instr, /TAKE EVERYTHING AN ANSWER GIVES YOU/);
    assert.match(instr, /Never ask for something WHO YOU ARE HELPING already says/);
});

test("it branches on age, and confirms rather than assumes", () => {
    assert.match(instr, /school/);
    assert.match(instr, /college/);
    assert.match(instr, /working/);
    assert.match(instr, /So you're in college\?/);
});

test("skip means skip, and a user ignoring it twice ends it", () => {
    assert.match(instr, /"SKIP" MEANS SKIP — THEIRS, NEVER YOURS/);
    assert.match(instr, /the whole note of THAT topic's section/);
    assert.match(instr, /Turning down\s+check-in times changes no note/,
        "a decline of a settings question left a skip in whichever section the model picked");
    assert.match(instr, /unrelatedReplies/);
    assert.match(instr, /reason "skipped"/);
    assert.match(instr, /Anything about themselves is an answer, even when it is not what you\s+asked/,
        "the seventh run counted \"those times are fine\" as unrelated and skipped a 12-year-old's onboarding");
});

test("the model never switches routines on — finishing does", () => {
    assert.match(instr, /Routines switch on by themselves when onboarding finishes/);
    assert.match(instr, /routines false/);
    assert.doesNotMatch(instr, /routines true/, "an instruction to turn them on would be refused by the tool anyway");
    assert.match(instr, /save\s+them even when they keep 09:00 and 23:00/,
        "an unsaved default leaves check-in times looking empty and gets asked again");
});

test("finishing reads back and completes in the same reply", () => {
    assert.match(instr, /FINISHING — only when ONBOARDING STATE says READY TO FINISH/);
    assert.match(instr, /reason "done" in the SAME\s+reply/);
    assert.match(instr, /Do not wait for\s+them to confirm/, "someone who never confirms must still get onboarded");
});

test("review mode reads back what is on file", () => {
    assert.match(instr, /REVIEW MODE/);
    // The third live eval kept "Backend developer in Pune" and added "Moved to
    // Bengaluru" — two cities, one of them wrong, both asserted every turn.
    assert.match(instr, /REWRITING the section to say only what is true now/);
});

// ── what code works out for the model ────────────────────────────────────────

test("a new profile is empty everywhere onboarding fills", () => {
    const empty = stillEmpty({ preferences: { triggersOptIn: false } });
    assert.deepStrictEqual(empty, [...NOTE_SECTIONS.map(s => s.label), "check-in times", "currency"]);
});

test("what is filled drops off the list", () => {
    const n = (text) => ({ text });
    const profile = {
        currency: "INR",
        preferences: { morningHour: 8 },
        notes: { about: n("19."), routine: n("Up at 7."), habits: { text: null } },
    };
    const empty = stillEmpty(profile);
    assert.ok(!empty.includes("About") && !empty.includes("Routine"));
    assert.ok(empty.includes("Habits"), "a cleared section is still empty");
    assert.ok(!empty.includes("check-in times"), "a saved hour means the times were chosen");
    assert.ok(!empty.includes("currency"));
    assert.ok(!stillEmpty({ preferences: { routinesChosenAt: new Date() } }).includes("check-in times"),
        "saying no to routines is also an answer");
});

// ── declines are read from their words, by code ──────────────────────────────

test("a decline is recognised from what they typed, not from a keyword anywhere", () => {
    for (const t of ["I'd rather not say", "skip", "pass", "Next.", "skip this one", "let's move on", "no comment"]) {
        assert.deepStrictEqual(classifyReply(t), { declined: true, stopAll: false }, t);
    }
    for (const t of ["none", "Nothing.", "not really", "nothing really"]) {
        assert.deepStrictEqual(classifyReply(t), { declined: true, stopAll: false }, `${t} — nothing to tell may say so`);
    }
    for (const t of ["skip the rest", "no more questions please", "enough questions", "stop asking", "that's enough"]) {
        assert.deepStrictEqual(classifyReply(t), { declined: true, stopAll: true }, t);
    }
    // Each of these would let the model skip one more topic if it matched.
    for (const t of ["I want to pass my exams", "I skip breakfast most days", "I want to move on from my job",
                     "I want to stop eating junk, this is important", "no food restrictions", "12", "no", "nothing new",
                     "[onboarding] Ask your first question."]) {
        assert.deepStrictEqual(classifyReply(t), { declined: false, stopAll: false }, t);
    }
});

// ── a skip is theirs: checked on the write, by code ──────────────────────────

const skipCall = (section, text = PLACEHOLDER) => ({ name: "updateNotes", args: { section, text } });
const DECLINED = { declined: true, stopAll: false };
const ANSWERED = { declined: false, stopAll: false };

test("a skip is refused in a message that turned nothing down", () => {
    const guard = createSkipGuard({ reply: ANSWERED, notes: {} });
    // The fourth run wrote one into Behaviour while they answered about times.
    assert.match(guard.check(skipCall("behaviour")), /they turned nothing down in this message\. Ask about Behaviour instead/);
    assert.match(createSkipGuard().check(skipCall("habits")), /turned nothing down/, "a job's trigger turns nothing down");
});

test("a filler is a skip too, whatever its words", () => {
    const guard = createSkipGuard({ reply: ANSWERED, notes: {} });
    // The fifth run, once the placeholder was guarded: "None." into two
    // sections never asked, and onboarding closed on them.
    for (const filler of ["None.", "N/A", "Not mentioned.", "No habits mentioned yet."]) {
        assert.match(guard.check(skipCall("habits", filler)), /says nothing/, filler);
    }
    for (const answer of ["No sugar.", "None of the above, works nights.", "Prefers not to say much about work, but is a nurse."]) {
        assert.ok(!saysNothing(answer), answer);
    }
    assert.ok(saysNothing(" Prefers not to say "));
    assert.strictEqual(createSkipGuard({ reply: classifyReply("none"), notes: {} }).check(skipCall("habits", "None.")), null,
        "\"none\" as the whole reply may leave the section saying so");
});

test("one decline skips one section", () => {
    const guard = createSkipGuard({ reply: DECLINED, notes: {} });
    assert.strictEqual(guard.check(skipCall("habits")), null);
    // The third run wrote one "I'd rather not say" into four sections.
    assert.match(guard.check(skipCall("shortTermGoals")), /only one topic may say nothing\. Ask about Short-term/);
});

test("a skip never replaces an answer, saved before or earlier in the same turn", () => {
    const before = createSkipGuard({ reply: DECLINED, notes: { behaviour: { text: "Be gentle." } } });
    assert.match(before.check(skipCall("behaviour")), /Behaviour already holds their answer, and a note saying nothing never replaces one/,
        "the fourth run overwrote \"be gentle\" with a skip");

    const sameTurn = createSkipGuard({ reply: DECLINED, notes: {} });
    assert.strictEqual(sameTurn.check(skipCall("behaviour", "Prefers a gentle approach.")), null);
    assert.match(sameTurn.check(skipCall("behaviour")), /already holds their answer/);
});

test("\"skip the rest\" skips every empty section; an answer may always replace a skip", () => {
    const rest = createSkipGuard({ reply: { declined: true, stopAll: true }, notes: { habits: { text: PLACEHOLDER } } });
    for (const section of ["habits", "shortTermGoals", "longTermGoals", "behaviour"]) {
        assert.strictEqual(rest.check(skipCall(section)), null, section);
    }
    const later = createSkipGuard({ reply: ANSWERED, notes: { habits: { text: PLACEHOLDER } } });
    assert.strictEqual(later.check(skipCall("habits", "Walks after every shift.")), null);
    assert.strictEqual(later.check({ name: "updateUserSettings", args: { routines: false } }), null, "only notes are guarded");
});

test("a turn that saved something about them cannot skip the onboarding", () => {
    const skipOnboarding = { name: "completeFlow", args: { flowType: "onboarding", reason: "skipped" } };
    const ok = (data) => ({ success: true, data });

    const answered = createSkipGuard({ reply: ANSWERED, notes: {} });
    assert.strictEqual(answered.check(skipOnboarding), null, "nothing learned yet: an unrelated message may skip");
    answered.record(skipCall("about", "Does not eat eggs."), ok({ action: "updated" }));
    assert.match(answered.check(skipOnboarding), /About was saved — so it is an answer, not an unrelated reply/);
    assert.strictEqual(answered.check({ name: "completeFlow", args: { flowType: "onboarding", reason: "done" } }), null,
        "finishing is the gate's call, not this guard's");
    assert.strictEqual(answered.check({ name: "completeFlow", args: { flowType: "goodNight", reason: "skipped" } }), null);

    const settings = createSkipGuard({ reply: ANSWERED, notes: {} });
    settings.record({ name: "updateUserSettings", args: { morningHour: 9 } }, ok({}));
    assert.match(settings.check(skipOnboarding), /a setting was saved/, "\"those times are fine\" is an answer");

    const nothingNew = createSkipGuard({ reply: ANSWERED, notes: {} });
    nothingNew.record(skipCall("about", "Backend developer."), ok({ action: "unchanged" }));
    nothingNew.record(skipCall("habits", "Reads daily."), { success: false, message: "Not saved" });
    assert.strictEqual(nothingNew.check(skipOnboarding), null, "re-saving what was there, or a refused write, learned nothing");

    const stop = createSkipGuard({ reply: classifyReply("enough questions"), notes: {} });
    stop.record({ name: "updateUserSettings", args: { routines: false } }, ok({}));
    assert.strictEqual(stop.check(skipOnboarding), null, "they asked to stop");
});

test("runAgent guards skips from the person's own message, never the job's trigger", () => {
    const src = read("src/agent/agent.js");
    assert.match(src, /reply: source === "telegram" \? classifyReply\(userInstruction\) : undefined/);
    assert.match(src, /notes: userProfile\?\.notes/);
    assert.match(src, /const refused = skipGuard\?\.check\(tc\)/);
    assert.match(src, /skipGuard\?\.record\(tc, result\)/, "the guard must hear what each call did");
    assert.doesNotMatch(src, /recordDecline/, "declines are no longer counted on the flow");
});

test("completeFlow starts after the step's other calls, and results keep their order", async () => {
    const events = [];
    const run = async (tc) => {
        events.push(`start ${tc.name}`);
        await new Promise(r => setTimeout(r, tc.name === "updateNotes" ? 25 : 0));
        events.push(`end ${tc.name}`);
        return { name: tc.name };
    };
    const results = await runStepCalls([{ name: "completeFlow" }, { name: "updateNotes" }, { name: "updateUserSettings" }], run);
    assert.deepStrictEqual(results.map(r => r.name), ["completeFlow", "updateNotes", "updateUserSettings"]);
    // Alongside them, the gate read the notes before they landed, and the model
    // overwrote a real answer to get past the refusal.
    assert.ok(events.indexOf("start completeFlow") > events.indexOf("end updateNotes"), events.join(" | "));
    assert.ok(events.indexOf("start updateUserSettings") < events.indexOf("end updateNotes"), "the rest still run in parallel");
    assert.match(read("src/agent/agent.js"), /await runStepCalls\(response\.toolCalls, async \(tc\) =>/);
});

test("the refusal no longer suggests the placeholder", () => {
    const src = read("src/scheduler/flows/completeFlow.js");
    assert.doesNotMatch(src, /If they would rather not say, save/,
        "suggesting it in the refusal is what taught a model to write it for questions it never asked");
});

test("only the six note sections gate finishing", () => {
    const n = (text) => ({ text });
    assert.deepStrictEqual(unfinishedSections({}), NOTE_SECTIONS.map(s => s.label));
    const full = Object.fromEntries(NOTE_SECTIONS.map(s => [s.key, n("Prefers not to say.")]));
    assert.deepStrictEqual(unfinishedSections({ notes: full }), [],
        "a saved refusal counts — it is what someone who will not answer leaves behind");
    assert.deepStrictEqual(unfinishedSections({ notes: { ...full, habits: { text: null } } }), ["Habits"]);
    assert.deepStrictEqual(unfinishedSections({ notes: full, currency: undefined, preferences: {} }), [],
        "settings never block finishing — unasked times are just the defaults");
});

test("the state block names the mode and the gaps", () => {
    const first = buildOnboardingContext(1, { profile: { preferences: {} } });
    assert.match(first, /MODE: firstTime/);
    assert.match(first, /STILL EMPTY: About/);
    assert.match(first, /NOT READY TO FINISH: ask about About, Routine, Habits, Short-term, Long-term, Behaviour\./);
    const full = Object.fromEntries(NOTE_SECTIONS.map(s => [s.key, { text: "x" }]));
    assert.match(buildOnboardingContext(1, { profile: { notes: full, preferences: {} } }), /READY TO FINISH: every section has a note/);

    const review = buildOnboardingContext(1, { profile: { onboardedAt: new Date(), preferences: {} } });
    assert.match(review, /MODE: review/);
});

test("the mode is code's call", () => {
    assert.strictEqual(onboardingMode({ onboardedAt: null }), "firstTime");
    assert.strictEqual(onboardingMode({ onboardedAt: new Date() }), "review");
    assert.strictEqual(onboardingMode(null), "firstTime");
});

test("the trigger is a knock on the door, not a payload", () => {
    for (const mode of ["firstTime", "review"]) {
        const p = onboardingFlow.buildTriggerPrompt(mode);
        assert.match(p, /^\[onboarding\]/);
        assert.ok(p.length < 80);
    }
    assert.notStrictEqual(onboardingFlow.buildTriggerPrompt("firstTime"), onboardingFlow.buildTriggerPrompt("review"));
});

// ── the welcome ──────────────────────────────────────────────────────────────

test("the welcome says what the bot does, and uses their name", () => {
    const w = welcomeMessage("Maya");
    assert.match(w, /Hi Maya/);
    assert.match(w, /I'll call you Maya — tell me if you'd rather something else/,
        "the name is confirmed here so no question is spent on it");
    assert.match(w, /\/start anytime/);
    assert.match(w, /switch off anytime/);
    assert.match(w, /start once we're set up/, "routines do not run until onboarding finishes, and the welcome must not promise otherwise");
});

test("no name, no invented one", () => {
    const w = welcomeMessage(null);
    assert.doesNotMatch(w, /Hi null|I'll call you/);
});

// ── the first question never goes missing ────────────────────────────────────

test("a question the model wrote is sent as written", async () => {
    const r = await composeOnboardingQuestion(1, "firstTime", { run: async () => ({ text: "How old are you, Maya?" }) });
    assert.deepStrictEqual(r, { text: "How old are you, Maya?", generated: true });
});

test("every unusable result falls back to a fixed question", async () => {
    const cases = [
        async () => { throw new Error("all models failed"); },
        async () => ({ text: NO_REPLY }),
        async () => ({ text: STEP_LIMIT_REPLY }),
        async () => ({ text: WORK_DONE_REPLY }),
        async () => ({ text: "Hi" }),
        async () => ({ text: "   " }),
    ];
    for (const run of cases) {
        const r = await composeOnboardingQuestion(1, "firstTime", { run });
        assert.strictEqual(r.generated, false);
        assert.match(r.text, /how old are you/i);
    }
    const review = await composeOnboardingQuestion(1, "review", { run: async () => ({ text: NO_REPLY }) });
    assert.match(review.text, /what I know about you/);
});

test("the question is asked with the job's source, so the transcript hides the trigger", async () => {
    let seen;
    await composeOnboardingQuestion(7, "firstTime", { run: async (userId, prompt, source) => { seen = { userId, prompt, source }; return { text: "How old are you?" }; } });
    assert.deepStrictEqual(seen, { userId: 7, prompt: "[onboarding] Ask your first question.", source: "userOnboardingJob" });
    assert.match(read("src/knowledge/dayTranscriptKnowledge.js"), /userOnboardingJob: "onboarding"/);
});

// ── how it sits in a turn ────────────────────────────────────────────────────

test("onboarding steps aside while a routine is open", () => {
    const onb = { flowType: "onboarding" };
    assert.deepStrictEqual(flowsForTurn([onb]), [onb]);
    assert.deepStrictEqual(flowsForTurn([onb, { flowType: "goodNight" }]), [{ flowType: "goodNight" }]);
    assert.deepStrictEqual(flowsForTurn([{ flowType: "goodMorning" }, onb]), [{ flowType: "goodMorning" }]);
});

test("a routine outranks onboarding for the model chain", () => {
    assert.strictEqual(resolveTask({ source: "telegram", openFlows: [{ flowType: "onboarding" }] }), "onboarding");
    assert.strictEqual(resolveTask({ source: "telegram", openFlows: [{ flowType: "onboarding" }, { flowType: "goodNight" }] }), "goodNight");
});

test("the flow's tools are added once, and only while it is open", () => {
    const base = toolRegistry.getToolDeclarations();
    assert.ok(!base.some(d => d.name === "updateUserSettings"), "settings must still be skill-only outside onboarding");

    const during = withFlowTools(base, [{ flowType: "onboarding" }]);
    assert.strictEqual(during.filter(d => d.name === "updateUserSettings").length, 1);
    assert.strictEqual(withFlowTools(during, [{ flowType: "onboarding" }]).filter(d => d.name === "updateUserSettings").length, 1,
        "a duplicate declaration is rejected by the providers");
    assert.strictEqual(withFlowTools(base, []), base);
    assert.strictEqual(withFlowTools(base, [{ flowType: "goodNight" }]), base);
});

test("runAgent extends idle flows, builds overlays from the active ones, and passes the profile", () => {
    const src = read("src/agent/agent.js");
    assert.match(src, /const activeFlows = flowsForTurn\(openFlows\)/);
    assert.match(src, /extendFlow\(f\._id/);
    assert.match(src, /buildFlowOverlay\(f, \{ userId, timeZone, profile: userProfile \}\)/);
    assert.match(src, /withFlowTools\(toolRegistry\.getToolDeclarations\(\), activeFlows\)/);
});

test("/start is recognised, and nothing else is", () => {
    for (const yes of ["/start", "/START", " /start ", "/start ref_abc", "/start@RasmalaiBot"]) {
        assert.strictEqual(isStartCommand(yes), true, yes);
    }
    for (const no of ["/startup", "start", "hi /start", "", null, undefined]) {
        assert.strictEqual(isStartCommand(no), false, String(no));
    }
});

test("anyone never onboarded or welcomed is onboarded on their next message", () => {
    assert.strictEqual(neverOnboarded({ onboardedAt: null }), true, "made before onboarding existed");
    assert.strictEqual(neverOnboarded({ onboardedAt: null, welcomedAt: new Date() }), false,
        "welcomed and walked away: /start resumes it, their messages are not hijacked");
    assert.strictEqual(neverOnboarded({ onboardedAt: new Date() }), false);
    assert.strictEqual(neverOnboarded(null), false, "a failed lookup never opens it");
});

test("the handler opens onboarding on /start and on a first message", () => {
    const src = read("src/tools/telegram/telegramHandler.js");
    assert.match(src, /const firstContact = isNew \|\| \(!start && neverOnboarded\(await getUserProfile\(userId\)\.catch\(\(\) => null\)\)\)/);
    assert.match(src, /if \(start \|\| firstContact\)/);
    assert.match(src, /userOnboardingJob\(\{ userId, chatId, askQuestion: start \}\)/,
        "a first message that is not /start gets its question from the agent's reply instead");
    assert.match(src, /if \(start\) return;/, "/start is the whole turn");
    assert.doesNotMatch(src, /TODO\(onboarding\)/);
});

test("onboarding is a flow type everywhere it has to be", () => {
    assert.match(read("src/tools/mongo/schema/activeFlowsSchema.js"), /enum: \["goodNight", "goodMorning", "onboarding"\]/);
    const d = toolRegistry.getTool("completeFlow").toFunctionDeclaration();
    assert.ok(d.parameters.properties.flowType.enum.includes("onboarding"));
    assert.match(read("src/config/agent.config.js"), /onboarding: \{/);
});

// ── the database half ────────────────────────────────────────────────────────

let db;
const seedUser = async (userId, extra = {}) => {
    const now = new Date();
    await db.collection("users").insertOne({
        userId, name: `User${userId}`, timezone: "Asia/Kolkata", status: "active",
        preferences: { triggersOptIn: false }, onboardedAt: null, createdAt: now, updatedAt: now, ...extra,
    });
};
const user = (userId) => db.collection("users").findOne({ userId });

test("the scratch database is the one being written", async () => {
    db = await getDB();
    assert.strictEqual(db.databaseName, SCRATCH_DB);
    assert.doesNotMatch(db.databaseName, /prod/i);
    await db.dropDatabase();
});

test("the welcome is claimed once, even by racing callers", async () => {
    await seedUser(1);
    const results = await Promise.all(Array.from({ length: 6 }, () => claimWelcome(1)));
    assert.strictEqual(results.filter(Boolean).length, 1);
    assert.ok((await user(1)).welcomedAt instanceof Date);
    assert.strictEqual(await claimWelcome(1), false);
});

test("finishing onboarding stamps it and switches routines on", async () => {
    await seedUser(2);
    const r = await markOnboarded(2);
    assert.strictEqual(r.firstCompletion, true);
    const u = await user(2);
    assert.ok(u.onboardedAt instanceof Date);
    assert.strictEqual(u.preferences.triggersOptIn, true);
});

test("someone who said no during onboarding keeps routines off", async () => {
    await seedUser(3, { preferences: { triggersOptIn: false, routinesChosenAt: new Date() } });
    const r = await markOnboarded(3);
    assert.strictEqual(r.firstCompletion, true);
    assert.strictEqual((await user(3)).preferences.triggersOptIn, false);
});

test("a later review changes neither onboardedAt nor routines", async () => {
    const first = (await user(2)).onboardedAt;
    await db.collection("users").updateOne({ userId: 2 }, { $set: { "preferences.triggersOptIn": false, "preferences.routinesChosenAt": new Date() } });
    const r = await markOnboarded(2, new Date(Date.now() + 86400000));
    assert.strictEqual(r.firstCompletion, false);
    const u = await user(2);
    assert.deepStrictEqual(u.onboardedAt, first);
    assert.strictEqual(u.preferences.triggersOptIn, false, "turned off in March, not back on by a review in May");
});

test("a user with no preferences object still gets routines on", async () => {
    await seedUser(4, { preferences: null });
    await markOnboarded(4);
    assert.strictEqual((await user(4)).preferences.triggersOptIn, true);
});

const fullNotes = () => Object.fromEntries(NOTE_SECTIONS.map(s => [s.key, { text: `${s.label} note.`, previousText: null, updatedAt: new Date() }]));

test("onboarding cannot finish with a section still empty", async () => {
    await seedUser(12, { notes: { about: { text: "19. College.", previousText: null, updatedAt: new Date() } } });
    await openFlow({ userId: 12, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });

    const refused = await completeFlow(12, "onboarding", "done");
    assert.strictEqual(refused.success, false);
    assert.strictEqual(refused.notFinished, true);
    assert.deepStrictEqual(refused.stillEmpty, ["Routine", "Habits", "Short-term", "Long-term", "Behaviour"]);
    assert.match(refused.message, /ask about the next one/);
    assert.doesNotMatch(refused.message, /Prefers not to say/, "a hint here taught a model to write it for questions it never asked");
    assert.strictEqual((await getOpenFlowsForUser(12)).length, 1, "a refusal leaves the onboarding open");
    assert.strictEqual((await user(12)).onboardedAt, null);

    await db.collection("users").updateOne({ userId: 12 }, { $set: { notes: fullNotes() } });
    const done = await completeFlow(12, "onboarding", "done");
    assert.strictEqual(done.success, true);
    assert.ok((await user(12)).onboardedAt instanceof Date);
});

test("stopping early is not held back by the gate", async () => {
    await seedUser(13);
    await openFlow({ userId: 13, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const skipped = await completeFlow(13, "onboarding", "skipped");
    assert.strictEqual(skipped.success, true, "someone who stopped answering must not be trapped in onboarding");
});

test("completeFlow marks onboarding only when it is done", async () => {
    await seedUser(5, { notes: fullNotes() });
    await openFlow({ userId: 5, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const skipped = await completeFlow(5, "onboarding", "skipped");
    assert.strictEqual(skipped.success, true);
    assert.strictEqual(skipped.onboarding, undefined);
    assert.strictEqual((await user(5)).onboardedAt, null, "a skipped onboarding is not a finished one");

    await openFlow({ userId: 5, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const done = await completeFlow(5, "onboarding", "done");
    assert.strictEqual(done.onboarding.firstCompletion, true);
    assert.strictEqual((await user(5)).preferences.triggersOptIn, true);
});

test("the completeFlow tool tells the model whether routines started", async () => {
    const { runWithUserContext } = await import("../identity/userContext.js");
    await seedUser(6, { preferences: { triggersOptIn: false, morningHour: 8 }, notes: fullNotes() });
    await openFlow({ userId: 6, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const r = await runWithUserContext({ userId: 6, channel: "test" },
        () => toolRegistry.execute("completeFlow", { flowType: "onboarding", reason: "done" }));
    assert.strictEqual(r.success, true);
    assert.match(r.message, /routines on — morning 08:00, night 23:00: tell them these start from now/);
});

test("finishing a review says nothing changed about routines", async () => {
    const { runWithUserContext } = await import("../identity/userContext.js");
    await seedUser(14, { onboardedAt: new Date("2026-08-01"), preferences: { triggersOptIn: true }, notes: fullNotes() });
    await openFlow({ userId: 14, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const r = await runWithUserContext({ userId: 14, channel: "test" },
        () => toolRegistry.execute("completeFlow", { flowType: "onboarding", reason: "done" }));
    assert.strictEqual(r.success, true);
    assert.match(r.message, /routines are unchanged — do not mention them/,
        "the eval had a review tell an existing user their routines start from now");
});

test("a user who declined hears their routines stay off", async () => {
    const { runWithUserContext } = await import("../identity/userContext.js");
    await seedUser(15, { preferences: { triggersOptIn: false, routinesChosenAt: new Date() }, notes: fullNotes() });
    await openFlow({ userId: 15, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const r = await runWithUserContext({ userId: 15, channel: "test" },
        () => toolRegistry.execute("completeFlow", { flowType: "onboarding", reason: "done" }));
    assert.match(r.message, /routines stay off, as they chose/);
});

test("the tool reports a refusal as not closed, not as a missing flow", async () => {
    const { runWithUserContext } = await import("../identity/userContext.js");
    await seedUser(16);
    await openFlow({ userId: 16, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const r = await runWithUserContext({ userId: 16, channel: "test" },
        () => toolRegistry.execute("completeFlow", { flowType: "onboarding", reason: "done" }));
    assert.strictEqual(r.success, false);
    assert.match(r.message, /^Not closed: onboarding is not finished — still empty: About/);
    assert.doesNotMatch(r.message, /No open onboarding flow/);
});

test("with no onboarding open, completeFlow says so instead of judging the notes", async () => {
    await seedUser(17);
    const r = await completeFlow(17, "onboarding", "done");
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.notFinished, undefined,
        "a refusal here sent a model back to 'fix' a closed onboarding, and it wrote a skip over an answer");
    assert.match(r.message, /no open flow of this type/);
});

test("a skip from an earlier onboarding never blocks finishing", async () => {
    const notes = fullNotes();
    notes.habits = { text: PLACEHOLDER, previousText: null, updatedAt: new Date("2026-08-01") };
    await seedUser(18, { onboardedAt: new Date("2026-08-01"), preferences: { triggersOptIn: true }, notes });
    await openFlow({ userId: 18, flowType: "onboarding", expiresAt: new Date(Date.now() + 15 * MIN) });
    const done = await completeFlow(18, "onboarding", "done");
    assert.strictEqual(done.success, true, "a review is never held behind a topic they turned down last month");
});

test("an open flow is extended; a closed one is never revived", async () => {
    const open = await openFlow({ userId: 7, flowType: "onboarding", expiresAt: new Date(Date.now() + MIN) });
    const later = new Date(Date.now() + 15 * MIN);
    assert.strictEqual(await extendFlow(open._id, later), true);
    assert.deepStrictEqual((await getOpenFlowsForUser(7))[0].expiresAt, later);

    await db.collection("activeFlows").updateOne({ _id: open._id }, { $set: { expiresAt: new Date(Date.now() - MIN) } });
    assert.deepStrictEqual(await getOpenFlowsForUser(7), [], "lazy expiry closes it");
    assert.strictEqual(await extendFlow(open._id, later), false, "a late message must not bring it back");
});

test("the job: first time welcomes and asks; a second /start only asks", async () => {
    await seedUser(8, { name: "Maya" });
    const sent = [];
    const send = async (chatId, text) => { sent.push({ chatId, text }); };
    const run = async () => ({ text: "How old are you?" });

    const first = await userOnboardingJob({ userId: 8, chatId: "c8", send, run });
    assert.strictEqual(first.mode, "firstTime");
    assert.strictEqual(first.welcomed, true);
    assert.strictEqual(sent.length, 2);
    assert.match(sent[0].text, /Hi Maya/);
    assert.strictEqual(sent[1].text, "How old are you?");

    const flows = await getOpenFlowsForUser(8);
    assert.strictEqual(flows.length, 1);
    assert.strictEqual(flows[0].flowType, "onboarding");
    const minutesLeft = (flows[0].expiresAt - Date.now()) / MIN;
    assert.ok(minutesLeft > 14 && minutesLeft <= 15, `expires in ${minutesLeft} minutes`);

    sent.length = 0;
    const again = await userOnboardingJob({ userId: 8, chatId: "c8", send, run });
    assert.strictEqual(again.welcomed, false, "an abandoned onboarding resumed later is not welcomed twice");
    assert.strictEqual(sent.length, 1);
    assert.strictEqual((await getOpenFlowsForUser(8)).length, 1, "the earlier flow is superseded, not duplicated");
});

test("the job: a first message that is not /start gets the welcome and no question", async () => {
    await seedUser(9, { name: "Arjun" });
    const sent = [];
    const r = await userOnboardingJob({
        userId: 9, chatId: "c9", askQuestion: false,
        send: async (_c, text) => sent.push(text),
        run: async () => { throw new Error("must not be called"); },
    });
    assert.strictEqual(r.welcomed, true);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /welcome to \*Rasmalai\*/i);
});

test("the job: someone onboarded gets a review, with no welcome", async () => {
    await seedUser(10, { onboardedAt: new Date("2026-08-01"), preferences: { triggersOptIn: true } });
    const sent = [];
    const r = await userOnboardingJob({
        userId: 10, chatId: "c10",
        send: async (_c, text) => sent.push(text),
        run: async () => ({ text: NO_REPLY }),
    });
    assert.strictEqual(r.mode, "review");
    assert.strictEqual(r.welcomed, false);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /what I know about you/, "the fixed review question when the model gives nothing");
});

test("the job: /start during a routine defers the review instead of hiding it", async () => {
    await seedUser(11, { onboardedAt: new Date("2026-08-01"), preferences: { triggersOptIn: true } });
    await openFlow({ userId: 11, flowType: "goodNight", expiresAt: new Date(Date.now() + 60 * MIN) });
    const sent = [];
    const r = await userOnboardingJob({
        userId: 11, chatId: "c11",
        send: async (_c, text) => sent.push(text),
        run: async () => { throw new Error("no question while a routine is open"); },
    });
    assert.strictEqual(r.deferred, true);
    assert.deepStrictEqual(sent, [ROUTINE_FIRST_MESSAGE]);
    const open = await getOpenFlowsForUser(11);
    assert.ok(!open.some(f => f.flowType === "onboarding"), "no onboarding may be opened under a routine");
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

try {
    const database = await getDB();
    assert.strictEqual(database.databaseName, SCRATCH_DB, "refusing to drop anything but the scratch database");
    await database.dropDatabase();
} catch (e) {
    console.log(`\ncould not drop ${SCRATCH_DB}: ${e.message}`);
}

console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
