/**
 * Hand-run:  node src/test/eval/evalOnboarding.js
 *            node src/test/eval/evalOnboarding.js --only school-first-time --show
 *            node src/test/eval/evalOnboarding.js --repeat 2
 *
 * Plays whole onboardings through the real path — resolveUserByChannel creating
 * the user, userOnboardingJob sending the welcome and first question, runAgent
 * and the real tools for every reply — against a live model, then grades what
 * actually landed on the users document, plus a few checks on what was asked.
 *
 * THIS WRITES TO MONGO — into its own database, `Rasmalai-onboarding-eval`,
 * dropped at the start and the end. A database whose name contains "prod" is
 * refused. Nothing is sent to Telegram: the job's `send` is captured here.
 *
 * The scripted replies do not follow the model's questions — they are written so
 * each one carries its facts whatever was asked, which is also the realistic
 * case: people answer what they want to. Their content deliberately avoids the
 * examples in the onboarding overlay, so a pass is never the model copying one
 * back.
 */
import "dotenv/config";
import { getDB, ensureIndexes } from "../../tools/mongo/mongoClient.js";
import { runAgent } from "../../agent/agent.js";
import { NO_REPLY } from "../../agent/instruction.js";
import { runWithUserContext } from "../../identity/userContext.js";
import { resolveUserByChannel } from "../../identity/userManager.js";
import { userOnboardingJob } from "../../scheduler/jobs/userOnboardingJob.js";
import { NOTE_SECTIONS } from "../../tools/mongo/schema/usersSchema.js";
import { classifyReply, saysNothing } from "../../agent/flows/onboardingFlow.js";

const OWN_DB = "Rasmalai-onboarding-eval";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const repeat = Number(flag("repeat", 1));
const only = flag("only", null);
const show = args.includes("--show");

process.env.MONGODB_DB_NAME = OWN_DB;
const db = await getDB();
if (db.databaseName !== OWN_DB || /prod/i.test(db.databaseName)) {
    console.error(`Refusing to run against "${db.databaseName}".`);
    process.exit(1);
}

// ── grading helpers ─────────────────────────────────────────────────────────
const note = (s, section) => s.user?.notes?.[section]?.text ?? "";
const allNotes = (s) => Object.values(s.user?.notes ?? {}).map(n => n?.text ?? "").join(" ");
const botMessages = (s) => s.log.filter(m => m.who === "bot");
const welcomes = (s) => botMessages(s).filter(m => /welcome to \*Rasmalai\*/i.test(m.text));
const botAfter = (s, userText) => {
    const i = s.log.findIndex(m => m.who === "user" && m.text === userText);
    return i === -1 ? [] : s.log.slice(i + 1).filter(m => m.who === "bot");
};
const lastBot = (s) => botMessages(s).at(-1)?.text ?? "";
const onboardingFlows = (s) => s.flows;
const doneFlow = (s) => onboardingFlows(s).some(f => f.state === "completed" && f.reason === "done");

const neverAskedAgain = (why, afterReply, pattern) => ({
    why,
    fn: s => !botAfter(s, afterReply).some(m => pattern.test(m.text)),
    detail: s => botAfter(s, afterReply).filter(m => pattern.test(m.text)).map(m => m.text).join(" || "),
});
// Two question marks, or one question whose halves are about DIFFERENT topics —
// "What are your favourite subjects, and what do you want to become?" got past a
// question-mark count in the first run. Halves on the same topic are one
// question: "working hours, and when do you wake?" is all a normal day, and
// "what your work involves, and your team" is all their work — both wrongly
// flagged by earlier versions. So school, college or work and one level deeper
// on it are one topic here.
const TOPIC_WORDS = {
    age: /\b(how old|your age)\b/i,
    occupation: /\b(school|college|work|job|study|studying|subjects?|branch|which year|team|field|focus)\b/i,
    home: /\b(where do you live|which city|live in|stay in)\b/i,
    household: /\b(live with|roommates?|family)\b/i,
    day: /\b(working hours|work hours|shifts?|wake|sleep|normal day|typical day|classes|school hours|routine)\b/i,
    checkIns: /\b(check-?ins?|morning plan|times suit)\b/i,
    health: /\b(food|allerg\w*|eat|health|diet)\b/i,
    nearGoal: /\b(next few months|short[- ]term|exams?|project|this year)\b/i,
    ambition: /\b(become|few years|long[- ]term|after (college|school|graduating))\b/i,
    habit: /\bhabits?\b/i,
    push: /\b(slip|push|nudge|straight|gentle)\b/i,
};
const topicsOf = (clause) => Object.keys(TOPIC_WORDS).filter(k => TOPIC_WORDS[k].test(clause));
const asksTwo = (text) => {
    if ((text.match(/\?/g) ?? []).length > 1) return true;
    const question = text.split(/(?<=[.!])\s+/).find(sentence => sentence.includes("?")) ?? "";
    const halves = question.match(/^(.*?)\s*,?\s+and\s+((?:what|when|where|how|who|do|are|would|which)\b.*)$/i);
    if (!halves) return false;
    const first = topicsOf(halves[1]);
    const second = topicsOf(halves[2]);
    return first.length > 0 && second.length > 0 && !first.some(t => second.includes(t));
};
const oneQuestionEach = {
    why: "no message asks more than one question",
    fn: s => !botMessages(s).some(m => asksTwo(m.text)),
    detail: s => botMessages(s).filter(m => asksTwo(m.text)).map(m => m.text).join(" || "),
};
// Graded on the notes as they stood when onboarding CLOSED, not at the end: a
// later turn can still repair them. In the third run a "yes" after the close
// is what saved "be gentle", and grading the end state hid that the onboarding
// itself closed with a skip where their answer should have been.
const atClose = (s) => s.atClose ?? s.user;
const noteAtClose = (s, section) => atClose(s)?.notes?.[section]?.text ?? "";
const everySectionNoted = {
    why: "every notes section had something when onboarding closed",
    fn: s => NOTE_SECTIONS.every(({ key }) => noteAtClose(s, key)),
    detail: s => NOTE_SECTIONS.filter(({ key }) => !noteAtClose(s, key)).map(({ key }) => key).join(", "),
};
// Held by every scenario: a section saying nothing — "Prefers not to say.",
// "None." — that they never earned is the model making something up about them.
const noInventedSkips = {
    why: "when onboarding closed, no more sections said nothing than they turned down",
    fn: s => {
        const skips = NOTE_SECTIONS.filter(({ key }) => saysNothing(noteAtClose(s, key))).length;
        const replies = s.log.filter(m => m.who === "user").map(m => classifyReply(m.text));
        return replies.some(r => r.stopAll) || skips <= replies.filter(r => r.declined).length;
    },
    detail: s => NOTE_SECTIONS.filter(({ key }) => saysNothing(noteAtClose(s, key))).map(({ key }) => `${key}: ${noteAtClose(s, key)}`).join(", "),
};
// Held by every scenario: a tool call the model wrote out as text reaches the
// person as gibberish — "opaquecall:default_api:loadSkill{skill:...}" in the
// third run, which no check caught.
const LEAKED_CALL = /opaquecall|default_api|^\s*\w+\s*\{[^}]*\}\s*$/;
const noLeakedCalls = {
    why: "no reply is a tool call written out as text",
    fn: s => !botMessages(s).some(m => LEAKED_CALL.test(m.text)),
    detail: s => botMessages(s).filter(m => LEAKED_CALL.test(m.text)).map(m => m.text).join(" || "),
};

const finished = [
    { why: "onboarding finished (completeFlow done)", fn: doneFlow, detail: s => JSON.stringify(onboardingFlows(s).map(f => [f.state, f.reason])) },
    { why: "marked onboarded", fn: s => s.user?.onboardedAt instanceof Date, detail: s => String(s.user?.onboardedAt) },
];

const SCENARIOS = [
    {
        name: "college-first-time",
        why: "a 19-year-old college student: every topic lands in the right place, and routines start",
        steps: [
            { job: true },
            "19",
            "2nd year mechanical engineering at VIT Vellore",
            "I stay in the VIT hostel with three roommates, my family is back in Kochi",
            "up at 7:30, classes 8 to 5, I sleep around midnight",
            "8 in the morning and 10 at night work better for me",
            "I'm vegetarian, no allergies",
            "in the next few months I want to finish our drone club project",
            "after college I want to do a masters in robotics in Germany",
            "I want to start running every morning",
            "just be straight with me",
            "looks right",
        ],
        checks: [
            { why: "welcomed exactly once", fn: s => welcomes(s).length === 1, detail: s => welcomes(s).length },
            { why: "about has the age", fn: s => /\b19\b/.test(note(s, "about")), detail: s => note(s, "about") },
            { why: "about has the college or course", fn: s => /VIT|mechanical/i.test(note(s, "about")), detail: s => note(s, "about") },
            { why: "about has where they live or are from", fn: s => /vellore|kochi/i.test(note(s, "about")), detail: s => note(s, "about") },
            { why: "currency set from where they live", fn: s => s.user?.currency === "INR", detail: s => s.user?.currency },
            { why: "check-in times saved as 08 and 22", fn: s => s.user?.preferences?.morningHour === 8 && s.user?.preferences?.nightHour === 22, detail: s => JSON.stringify(s.user?.preferences) },
            { why: "routine filled", fn: s => Boolean(note(s, "routine")), detail: s => note(s, "routine") },
            { why: "vegetarian noted", fn: s => /vegetarian/i.test(allNotes(s)), detail: s => allNotes(s) },
            { why: "short-term goal: the drone project", fn: s => /drone/i.test(note(s, "shortTermGoals")), detail: s => note(s, "shortTermGoals") },
            { why: "long-term goal: robotics masters", fn: s => /robotic|germany|master/i.test(note(s, "longTermGoals")), detail: s => note(s, "longTermGoals") },
            { why: "habit: running", fn: s => /run/i.test(note(s, "habits")), detail: s => note(s, "habits") },
            { why: "behaviour: straight", fn: s => /straight|direct|blunt|honest/i.test(note(s, "behaviour")), detail: s => note(s, "behaviour") },
            ...finished,
            { why: "routines switched on at the end", fn: s => s.user?.preferences?.triggersOptIn === true, detail: s => JSON.stringify(s.user?.preferences) },
            neverAskedAgain("age never asked again after it was given", "19", /how old|your age/i),
            everySectionNoted,
            oneQuestionEach,
        ],
    },
    {
        name: "school-first-time",
        why: "a 12-year-old: school, class and what they want to become",
        steps: [
            { job: true },
            "12",
            "class 7 at St. Xavier's School in Ahmedabad",
            "with my mom, dad and little sister",
            "school is 7:30 to 1:30, I sleep at 9:30",
            "those times are fine",
            "I don't eat eggs",
            "my half-yearly exams are next month",
            "I want to become an astronaut",
            "reading for 20 minutes every day",
            "gently please",
            "ok",
        ],
        checks: [
            { why: "about has the age", fn: s => /\b12\b/.test(note(s, "about")), detail: s => note(s, "about") },
            { why: "about has the school or class", fn: s => /xavier|class 7|7th|grade 7/i.test(note(s, "about")), detail: s => note(s, "about") },
            { why: "long-term goal: astronaut", fn: s => /astronaut/i.test(note(s, "longTermGoals")), detail: s => note(s, "longTermGoals") },
            { why: "short-term goal: the exams", fn: s => /exam/i.test(note(s, "shortTermGoals")), detail: s => note(s, "shortTermGoals") },
            { why: "accepted default times were still saved", fn: s => s.user?.preferences?.morningHour != null || s.user?.preferences?.nightHour != null, detail: s => JSON.stringify(s.user?.preferences) },
            { why: "currency set from the city mentioned in passing", fn: s => s.user?.currency === "INR", detail: s => s.user?.currency },
            ...finished,
            { why: "routines switched on at the end", fn: s => s.user?.preferences?.triggersOptIn === true, detail: s => JSON.stringify(s.user?.preferences) },
            everySectionNoted,
            oneQuestionEach,
        ],
    },
    {
        name: "everything-at-once",
        why: "one long answer covers half the topics: none of them is asked again",
        steps: [
            { job: true },
            "I'm 26, a data analyst at a fintech in Bengaluru, I live alone. Up at 9, work 10 to 7, sleep at 1. I want to move into ML engineering this year and one day start my own company.",
            "the usual times are fine",
            "no food restrictions",
            "I want to get back to reading",
            "straight",
            "yes",
        ],
        checks: (() => {
            const dump = "I'm 26, a data analyst at a fintech in Bengaluru, I live alone. Up at 9, work 10 to 7, sleep at 1. I want to move into ML engineering this year and one day start my own company.";
            return [
                { why: "about has age, job and city", fn: s => /\b26\b/.test(note(s, "about")) && /analyst/i.test(note(s, "about")) && /bengaluru|bangalore/i.test(note(s, "about")), detail: s => note(s, "about") },
                { why: "ML move recorded as a goal", fn: s => /\bML\b|machine learning/i.test(note(s, "shortTermGoals") + " " + note(s, "longTermGoals")), detail: s => JSON.stringify({ short: note(s, "shortTermGoals"), long: note(s, "longTermGoals") }) },
                { why: "own company recorded long-term", fn: s => /compan|startup|business/i.test(note(s, "longTermGoals")), detail: s => note(s, "longTermGoals") },
                neverAskedAgain("age, city, job or day not asked after the long answer", dump,
                    /how old|your age|where do you live|which city|what do you do|where do you work|when do you (wake|sleep)|what time do you wake/i),
                ...finished,
                everySectionNoted,
            ];
        })(),
    },
    {
        name: "review-after-move",
        why: "an onboarded user sends /start: no welcome, reads back, updates a move, keeps routines",
        seed: {
            onboardedAt: new Date(Date.now() - 30 * 86400000),
            currency: "INR",
            preferences: { triggersOptIn: true },
            notes: {
                about: { text: "Backend developer in Pune, working at a logistics startup.", previousText: null, updatedAt: new Date() },
                routine: { text: "Up at 9, works 10 to 7, asleep by 1.", previousText: null, updatedAt: new Date() },
            },
        },
        steps: [
            { job: true },
            "I moved to Bengaluru last month, still backend at the same startup",
            "the rest is still right",
            "this year I want to get properly good at system design",
            "long term I'd like to become a staff engineer",
            "I'm trying to swim twice a week",
            "keep it short and direct with me",
            "nothing new",
        ],
        checks: [
            { why: "no welcome for someone onboarded", fn: s => welcomes(s).length === 0, detail: s => welcomes(s).length },
            { why: "the review opens by reading back what is on file", fn: s => /pune|backend|logistics/i.test(botMessages(s)[0]?.text ?? ""), detail: s => botMessages(s)[0]?.text },
            { why: "about now says Bengaluru", fn: s => /bengaluru|bangalore/i.test(note(s, "about")), detail: s => note(s, "about") },
            { why: "about no longer places them in Pune", fn: s => !/(lives?|based|developer|working|living) in Pune/i.test(note(s, "about")), detail: s => note(s, "about") },
            { why: "onboardedAt unchanged", fn: s => s.user?.onboardedAt?.getTime() === s.seed.onboardedAt.getTime(), detail: s => String(s.user?.onboardedAt) },
            { why: "routines still on", fn: s => s.user?.preferences?.triggersOptIn === true, detail: s => JSON.stringify(s.user?.preferences) },
            { why: "the empty sections were filled by the close", fn: s => ["shortTermGoals", "longTermGoals", "habits", "behaviour"].every(k => noteAtClose(s, k)), detail: s => JSON.stringify(atClose(s)?.notes) },
            { why: "the review finished", fn: doneFlow, detail: s => JSON.stringify(onboardingFlows(s).map(f => [f.state, f.reason])) },
            { why: "never told an existing user their routines start now", fn: s => !botMessages(s).some(m => /start(s|ing)? (from )?now|from now on/i.test(m.text)), detail: s => botMessages(s).map(m => m.text).filter(t => /now/i.test(t)).join(" || ") },
        ],
    },
    {
        name: "declines-routines",
        why: "saying no to daily messages survives onboarding's completion",
        steps: [
            { job: true },
            "31",
            "freelance designer, I work from home in Goa",
            "no daily messages please, I'll text you when I need something",
            "I live with my partner, wake around 10, work afternoons",
            "no restrictions",
            "land two big clients this quarter",
            "open a small design studio in a few years",
            "yoga three times a week",
            "gentle",
            "yes that's right",
        ],
        checks: [
            ...finished,
            { why: "routines stayed off", fn: s => s.user?.preferences?.triggersOptIn === false, detail: s => JSON.stringify(s.user?.preferences) },
            { why: "the refusal was recorded as a choice", fn: s => s.user?.preferences?.routinesChosenAt instanceof Date, detail: s => JSON.stringify(s.user?.preferences) },
            {
                why: "declining routines did not end the onboarding early",
                fn: s => ["no daily messages please, I'll text you when I need something", "I live with my partner, wake around 10, work afternoons"]
                    .every(t => s.log.find(m => m.who === "user" && m.text === t)?.openAfter === true),
                detail: s => s.log.filter(m => m.who === "user").map(m => `${m.text.slice(0, 24)}…=${m.openAfter ? "open" : "closed"}`).join(" | "),
            },
            everySectionNoted,
        ],
    },
    {
        name: "skips-one-topic",
        why: "a topic they decline is skipped, not re-asked, and does not stop onboarding finishing",
        steps: [
            { job: true },
            "24, I work as a pharmacist at a chemist shop in Indore",
            "evening shifts mostly, I live with my brother",
            "I'd rather not say",
            "I wake at 11, work 3pm to 11pm, sleep around 2",
            "the default times don't work, make it 1pm and midnight",
            "I'm diabetic, so no sugar",
            "I want to clear my pharmacy licence exam for the UK this year",
            "long term I want to settle abroad with my family",
            "walking 30 minutes after every shift",
            "be gentle",
            "yes",
        ],
        checks: [
            ...finished,
            everySectionNoted,
            { why: "check-in times saved as 13 and 00", fn: s => s.user?.preferences?.morningHour === 13 && s.user?.preferences?.nightHour === 0, detail: s => JSON.stringify(s.user?.preferences) },
            { why: "behaviour when it closed: their answer, not a skip", fn: s => /gentl|soft|kind/i.test(noteAtClose(s, "behaviour")), detail: s => noteAtClose(s, "behaviour") },
            { why: "habits when it closed: the walk", fn: s => /walk/i.test(noteAtClose(s, "habits")), detail: s => noteAtClose(s, "habits") },
            oneQuestionEach,
        ],
    },
    {
        name: "abandon-resume",
        why: "an onboarding left idle and restarted: no second welcome, answered topics not re-asked",
        steps: [
            { job: true },
            "22",
            "final year B.Com at Loyola College in Chennai",
            { expire: true },
            { job: true },
        ],
        checks: [
            { why: "welcomed exactly once across both starts", fn: s => welcomes(s).length === 1, detail: s => welcomes(s).length },
            { why: "the restarted question does not ask age or college again", fn: s => !/how old|your age|which college|what (do|are) you study/i.test(lastBot(s)), detail: s => lastBot(s) },
            { why: "exactly one onboarding open after the restart", fn: s => onboardingFlows(s).filter(f => f.state === "open").length === 1, detail: s => JSON.stringify(onboardingFlows(s).map(f => f.state)) },
        ],
    },
];

// ── run ─────────────────────────────────────────────────────────────────────
const scenarios = only ? SCENARIOS.filter(s => s.name === only) : SCENARIOS;
if (!scenarios.length) {
    console.error(`No scenario "${only}". Known: ${SCENARIOS.map(s => s.name).join(", ")}`);
    process.exit(1);
}

await db.dropDatabase();
await ensureIndexes();

const results = [];

for (const scenario of scenarios) {
    for (let run = 1; run <= repeat; run++) {
        const record = { name: scenario.name, run, why: scenario.why, log: [], models: new Set() };
        const started = Date.now();
        const chatId = `eval-chat-${scenario.name}-${run}`;

        try {
            const { userId } = await resolveUserByChannel("telegram", `eval-${scenario.name}-${run}`, {
                address: chatId, displayName: "Eval",
            });
            if (scenario.seed) await db.collection("users").updateOne({ userId }, { $set: scenario.seed });

            const ctx = { userId, channel: "telegram", address: chatId };
            const send = async (_chat, text) => { record.log.push({ who: "bot", via: "job", text }); };

            for (const step of scenario.steps) {
                if (step?.job) {
                    await runWithUserContext(ctx, () => userOnboardingJob({ userId, chatId, send }));
                    continue;
                }
                if (step?.expire) {
                    await db.collection("activeFlows").updateMany(
                        { userId, flowType: "onboarding", state: "open" },
                        { $set: { expiresAt: new Date(Date.now() - 60 * 1000) } }
                    );
                    continue;
                }
                const entry = { who: "user", text: step };
                record.log.push(entry);
                const out = await runWithUserContext(ctx, () => runAgent(userId, step, "telegram"));
                // Whether onboarding survived this turn — the only way to tell a
                // close that came too early from one that came at the end.
                entry.openAfter = (await db.collection("activeFlows")
                    .countDocuments({ userId, flowType: "onboarding", state: "open" })) > 0;
                // The users document as onboarding left it — see noteAtClose.
                if (!record.atClose && await db.collection("activeFlows")
                    .countDocuments({ userId, flowType: "onboarding", state: "completed" })) {
                    record.atClose = await db.collection("users").findOne({ userId });
                }
                for (const m of out?.metrics?.models ?? []) record.models.add(m);
                const text = typeof out === "string" ? out : out?.text;
                if (text && text.trim() !== NO_REPLY) record.log.push({ who: "bot", via: "agent", text });
            }

            const state = {
                seed: scenario.seed,
                log: record.log,
                user: await db.collection("users").findOne({ userId }),
                atClose: record.atClose,
                flows: await db.collection("activeFlows").find({ userId, flowType: "onboarding" }).sort({ startedAt: 1 }).toArray(),
            };
            record.state = state;
            record.checks = [...scenario.checks, noInventedSkips, noLeakedCalls].map(c => ({ ok: Boolean(c.fn(state)), why: c.why, detail: c.detail ? c.detail(state) : undefined }));
        } catch (err) {
            record.error = err.stack ?? err.message;
            record.checks = [];
        } finally {
            record.seconds = Math.round((Date.now() - started) / 1000);
        }

        results.push(record);
        const status = record.error ? "ERROR" : `${record.checks.filter(c => c.ok).length}/${record.checks.length}`;
        console.log(`  ${scenario.name.padEnd(22)} run ${run}  ${status.padEnd(6)} ${record.seconds}s  ${[...record.models].join(", ")}`);
    }
}

// ── report ──────────────────────────────────────────────────────────────────
const line = "=".repeat(96);
const failed = results.filter(r => r.error || r.checks.some(c => !c.ok));
const checksTotal = results.reduce((n, r) => n + r.checks.length, 0);
const checksOk = results.reduce((n, r) => n + r.checks.filter(c => c.ok).length, 0);
console.log(`\n${line}\nONBOARDING EVAL — ${db.databaseName} — ${results.length - failed.length}/${results.length} scenarios fully passed, ${checksOk}/${checksTotal} checks\n${line}`);

for (const r of failed) {
    console.log(`\n${r.name} (run ${r.run}) — ${r.why}`);
    if (r.error) { console.log(`  ERROR: ${r.error}`); continue; }
    for (const c of r.checks.filter(x => !x.ok)) {
        console.log(`  ✗ ${c.why}`);
        if (c.detail !== undefined) console.log(`      got: ${String(c.detail).slice(0, 400)}`);
    }
}

if (show) {
    console.log(`\n${line}\nCONVERSATIONS\n${line}`);
    for (const r of results.filter(x => !x.error)) {
        console.log(`\n--- ${r.name} (run ${r.run}) · ${[...r.models].join(", ") || "?"} ---`);
        for (const m of r.log) {
            const trail = m.who === "user" && m.openAfter !== undefined ? `   [onboarding ${m.openAfter ? "open" : "closed"}]` : "";
            console.log(`${m.who === "user" ? "USER    " : m.via === "job" ? "RASMALAI (job)" : "RASMALAI"}: ${m.text}${trail}`);
        }
        const u = r.state.user;
        console.log(`[users] onboardedAt=${u?.onboardedAt?.toISOString?.() ?? null} currency=${u?.currency} tz=${u?.timezone} prefs=${JSON.stringify(u?.preferences)}`);
        for (const [section, n] of Object.entries(u?.notes ?? {})) {
            if (n?.text) console.log(`[notes.${section}] ${n.text}`);
        }
    }
}

await db.dropDatabase();
process.exit(failed.length ? 1 : 0);
