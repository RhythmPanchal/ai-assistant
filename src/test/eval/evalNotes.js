/**
 * Hand-run:  node src/test/eval/evalNotes.js
 *            node src/test/eval/evalNotes.js --only long-term-conflict --show
 *            node src/test/eval/evalNotes.js --repeat 2
 *
 * Plays short conversations through the real runAgent and tools against a live
 * model, then grades the NOTES as they landed in the database — not the prose.
 * The unit tests prove the plumbing; this is the only thing that checks whether
 * the model actually keeps the notes the way the instructions describe: writes
 * what lasts, leaves events and small talk alone, merges instead of wiping,
 * keeps two conflicting goals, and lets the routine drift slowly.
 *
 * THIS WRITES TO MONGO — into its own database, `Rasmalai-notes-eval`, which is
 * dropped at the start and the end. Not `Rasmalai-eval`: the night eval and its
 * guards keep state there, and this file drops whatever it runs in. Passing
 * --db runs elsewhere and then only this eval's own users are deleted. A
 * database whose name contains "prod" is refused.
 *
 * Each scenario runs as its own user, so no conversation can see another's
 * history, flows or notes. Nothing is sent to Telegram.
 */
import "dotenv/config";
import { getDB, ensureIndexes } from "../../tools/mongo/mongoClient.js";
import { runAgent } from "../../agent/agent.js";
import { runWithUserContext } from "../../identity/userContext.js";
import { openFlow } from "../../scheduler/flows/activeFlowsRepo.js";
import goodNightFlow from "../../agent/flows/goodNightFlow.js";
import { NOTE_SECTIONS } from "../../tools/mongo/schema/usersSchema.js";
import { IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";

const OWN_DB = "Rasmalai-notes-eval";
const FIRST_USER_ID = 900301;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const repeat = Number(flag("repeat", 1));
const only = flag("only", null);
const show = args.includes("--show");

process.env.MONGODB_DB_NAME = flag("db", OWN_DB);
const db = await getDB();
if (/prod/i.test(db.databaseName)) {
    console.error(`Refusing to run against "${db.databaseName}".`);
    process.exit(1);
}
const ownDatabase = db.databaseName === OWN_DB;

// ── helpers the scenarios grade with ────────────────────────────────────────
const text = (notes, section) => notes?.[section]?.text ?? "";
const unchanged = (s, section) => (s.before?.[section]?.text ?? null) === (s.after?.[section]?.text ?? null);
const nothingChanged = s => NOTE_SECTIONS.every(({ key }) => unchanged(s, key));
const changedSections = s => NOTE_SECTIONS.map(({ key }) => key).filter(key => !unchanged(s, key));
const reply = (s, i = 0) => s.turns[i]?.agent ?? "";

const ANNOUNCED = /\b(noted|I'll remember|I will remember|saved (that|it)|updated (your )?(profile|notes|routine)|added (that |it )?to your (profile|notes))\b/i;
const silent = (i = 0) => ({
    why: "the save is not announced",
    fn: s => !ANNOUNCED.test(reply(s, i)),
    detail: s => reply(s, i),
});

const DAY_LOG = "Breakfast was poha, lunch was dal rice, dinner was roti sabzi. No work to log today and no spending.";

const SCENARIOS = [
    {
        name: "fact-about",
        why: "something that will still be true next week lands in about",
        replies: ["btw I moved to Pune last month for work"],
        checks: [
            { why: "about mentions Pune", fn: s => /pune/i.test(text(s.after, "about")), detail: s => text(s.after, "about") },
            { why: "no other section was written", fn: s => changedSections(s).every(k => k === "about"), detail: s => changedSections(s).join(", ") },
            silent(),
        ],
    },
    {
        name: "merge-not-wipe",
        why: "a write REPLACES the section, so the model has to merge what was there",
        notes: { about: "Backend developer." },
        replies: ["I've turned vegetarian recently"],
        checks: [
            { why: "about now says vegetarian", fn: s => /vegetarian/i.test(text(s.after, "about")), detail: s => text(s.after, "about") },
            { why: "and still says backend developer", fn: s => /backend/i.test(text(s.after, "about")), detail: s => text(s.after, "about") },
            silent(),
        ],
    },
    {
        name: "habit",
        why: "a practice they want to keep up lands in habits",
        replies: ["I want to start going to the gym three times a week"],
        checks: [
            { why: "habits mentions the gym", fn: s => /gym/i.test(text(s.after, "habits")), detail: s => JSON.stringify(s.after ?? {}) },
            silent(),
        ],
    },
    {
        name: "short-term-goal",
        why: "something to achieve over weeks or months lands in shortTermGoals",
        replies: ["for the next three months I'm learning Rust properly, I want to move into a systems role"],
        checks: [
            { why: "shortTermGoals mentions Rust", fn: s => /rust/i.test(text(s.after, "shortTermGoals")), detail: s => JSON.stringify(s.after ?? {}) },
            silent(),
        ],
    },
    {
        name: "long-term-conflict",
        why: "a new long-term goal that pulls against an old one is kept alongside it, and raised",
        notes: { longTermGoals: "Move to Canada within five years." },
        replies: ["honestly I'm thinking of buying a flat in Ahmedabad and settling down here"],
        checks: [
            { why: "the Canada goal is still in the notes", fn: s => /canada/i.test(text(s.after, "longTermGoals")), detail: s => text(s.after, "longTermGoals") },
            // Where it lands is the model's call — a flat is arguably either horizon.
            {
                why: "the flat is recorded as a goal",
                fn: s => /flat|ahmedabad|settl/i.test(text(s.after, "shortTermGoals") + " " + text(s.after, "longTermGoals")),
                detail: s => JSON.stringify({ short: text(s.after, "shortTermGoals"), long: text(s.after, "longTermGoals") }),
            },
            { why: "the reply names the pull against Canada", fn: s => /canada/i.test(reply(s)), detail: s => reply(s) },
        ],
    },
    {
        name: "situation-not-routine",
        why: "a situation that lasts months is who they are for now, not how their day runs",
        notes: { routine: "Up at 7, office 9:30 to 6:30, asleep by midnight." },
        replies: ["we're staying at my in-laws' place in Thane for the next few months while our flat is renovated"],
        checks: [
            { why: "about has the stay", fn: s => /thane|in-laws|renovat/i.test(text(s.after, "about")), detail: s => JSON.stringify(s.after ?? {}) },
            { why: "routine is unchanged", fn: s => unchanged(s, "routine"), detail: s => text(s.after, "routine") },
        ],
    },
    {
        // Prod's Routine held a situation that belonged in About. Asked to move
        // such things while rewriting, fallback models never did and once
        // deleted it — so the rule was dropped, 007 moves prod's, and this
        // checks only that a rewrite keeps what it does not understand.
        name: "rewrite-keeps-the-rest",
        why: "rewriting a section for one change loses nothing else it held",
        notes: {
            about: "Accountant in Kochi.",
            routine: "Up at 6:30, gym at 7, office 9 to 6. Looking for a new school for their son before the next term.",
        },
        replies: ["I've moved my gym to the evenings now, around 7pm"],
        checks: [
            { why: "routine has the evening gym", fn: s => /evening|7 ?pm|19:00/i.test(text(s.after, "routine")), detail: s => text(s.after, "routine") },
            {
                why: "the school search is still in the notes",
                fn: s => NOTE_SECTIONS.some(({ key }) => /school/i.test(text(s.after, key))),
                detail: s => JSON.stringify(s.after ?? {}),
            },
        ],
    },
    {
        name: "event-not-note",
        why: "a meal and a spend are events for their registers, not notes",
        replies: ["had dal chawal for lunch and spent 250 on an auto"],
        checks: [
            { why: "no note section changed", fn: nothingChanged, detail: s => changedSections(s).join(", ") },
        ],
    },
    {
        name: "small-talk",
        why: "an acknowledgement changes nothing",
        notes: { about: "Backend developer." },
        replies: ["ok thanks"],
        checks: [
            { why: "no note section changed", fn: nothingChanged, detail: s => changedSections(s).join(", ") },
        ],
    },
    {
        name: "drift-in-conversation",
        why: "work pulling away from a short-term goal is named once, and the goal is not overwritten",
        notes: { shortTermGoals: "Learning Rust over the next three months, to move into a systems role." },
        replies: ["let's do a React tutorial today, can you plan a couple of hours for it?"],
        checks: [
            { why: "the reply mentions the Rust goal", fn: s => /rust/i.test(reply(s)), detail: s => reply(s) },
            { why: "shortTermGoals still holds Rust", fn: s => /rust/i.test(text(s.after, "shortTermGoals")), detail: s => text(s.after, "shortTermGoals") },
        ],
    },
    {
        name: "night-one-early-start",
        why: "one early morning is not a new routine",
        night: true,
        notes: { routine: "Up around 10:00, works until about 21:00, asleep around 01:00." },
        replies: [`${DAY_LOG} I had to wake up at 6 today for an early flight. That's all for today.`],
        checks: [
            { why: "routine is unchanged", fn: s => unchanged(s, "routine"), detail: s => text(s.after, "routine") },
        ],
    },
    {
        name: "night-routine-changed",
        why: "a change they say has held for weeks moves the routine",
        night: true,
        notes: { routine: "Up around 10:00, works until about 21:00, asleep around 01:00." },
        replies: [`${DAY_LOG} Also, since the new job started three weeks ago I've been waking at 7 every day and sleeping by 11. That's all for today.`],
        checks: [
            { why: "routine now says 7", fn: s => /\b7\b|07:00|7:00|seven/i.test(text(s.after, "routine")), detail: s => text(s.after, "routine") },
            { why: "routine no longer says 10:00", fn: s => !/10:00/.test(text(s.after, "routine")), detail: s => text(s.after, "routine") },
            silent(),
        ],
    },
    {
        name: "night-weekly-nudge",
        why: "the first routine turn of the week may raise one slipping habit, and only once",
        night: true,
        notes: { habits: "Wants to work on Rasmalai most weeknights; skipped it the last five nights." },
        replies: [DAY_LOG, "ok good night"],
        checks: [
            { why: "the week's chance was claimed", fn: s => Boolean(s.lastNudgedAt), detail: s => String(s.lastNudgedAt) },
            { why: "the first reply raises Rasmalai", fn: s => /rasmalai/i.test(reply(s, 0)), detail: s => reply(s, 0) },
            { why: "the second reply does not raise it again", fn: s => !/rasmalai/i.test(reply(s, 1)), detail: s => reply(s, 1) },
        ],
    },
];

// ── run ─────────────────────────────────────────────────────────────────────
const scenarios = only ? SCENARIOS.filter(s => s.name === only) : SCENARIOS;
if (!scenarios.length) {
    console.error(`No scenario "${only}". Known: ${SCENARIOS.map(s => s.name).join(", ")}`);
    process.exit(1);
}

async function resetDatabase() {
    if (ownDatabase) {
        await db.dropDatabase();
        return;
    }
    const ids = SCENARIOS.map((_, i) => FIRST_USER_ID + i);
    const names = (await db.listCollections().toArray()).map(c => c.name);
    await Promise.all(names.map(name => db.collection(name).deleteMany({ userId: { $in: ids } })));
}

await resetDatabase();
// Everything the service builds at boot, so this database refuses what prod refuses.
await ensureIndexes();

const note = (value) => ({ text: value, previousText: null, updatedAt: new Date(Date.now() - 30 * 864e5) });
const results = [];

for (const scenario of scenarios) {
    const userId = FIRST_USER_ID + SCENARIOS.indexOf(scenario);

    for (let run = 1; run <= repeat; run++) {
        const record = { name: scenario.name, run, why: scenario.why, turns: [], models: new Set() };
        const started = Date.now();

        try {
            const now = new Date();
            await Promise.all(["users", "activeFlows", "chatHistory", "dietRegister", "taskRegister", "expenseRegister", "llmUsage"]
                .map(c => db.collection(c).deleteMany({ userId })));

            const notes = Object.fromEntries(Object.entries(scenario.notes ?? {}).map(([k, v]) => [k, note(v)]));
            await db.collection("users").insertOne({
                userId, name: "Eval", timezone: IST_TIMEZONE, currency: "INR", status: "active",
                evalUser: true, createdAt: now, updatedAt: now,
                ...(Object.keys(notes).length ? { notes } : {}),
            });
            const before = (await db.collection("users").findOne({ userId })).notes ?? {};

            if (scenario.night) {
                await openFlow({ userId, flowType: goodNightFlow.flowType, expiresAt: goodNightFlow.computeExpiry(IST_TIMEZONE) });
            }

            for (const message of scenario.replies) {
                const out = await runWithUserContext(
                    { userId, channel: "eval", reason: `notes-eval:${scenario.name}` },
                    () => runAgent(userId, message, "telegram")
                );
                for (const m of out?.metrics?.models ?? []) record.models.add(m);
                record.turns.push({ user: message, agent: typeof out === "string" ? out : out?.text });
            }

            const after = (await db.collection("users").findOne({ userId })).notes ?? {};
            const state = { before, after, turns: record.turns, lastNudgedAt: after.lastNudgedAt ?? null };
            record.state = state;
            record.checks = scenario.checks.map(c => ({ ok: Boolean(c.fn(state)), why: c.why, detail: c.detail ? c.detail(state) : undefined }));
        } catch (err) {
            record.error = err.stack ?? err.message;
            record.checks = [];
        } finally {
            record.seconds = Math.round((Date.now() - started) / 1000);
        }

        results.push(record);
        const status = record.error ? "ERROR" : `${record.checks.filter(c => c.ok).length}/${record.checks.length}`;
        console.log(`  ${scenario.name.padEnd(24)} run ${run}  ${status.padEnd(6)} ${record.seconds}s  ${[...record.models].join(", ")}`);
    }
}

// ── report ──────────────────────────────────────────────────────────────────
const line = "=".repeat(96);
const failed = results.filter(r => r.error || r.checks.some(c => !c.ok));
console.log(`\n${line}\nNOTES EVAL — ${db.databaseName} — ${results.length - failed.length}/${results.length} scenarios fully passed\n${line}`);

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
        for (const t of r.turns) console.log(`USER:     ${t.user}\nRASMALAI: ${t.agent}`);
        for (const { key } of NOTE_SECTIONS) {
            const b = r.state.before?.[key]?.text ?? null;
            const a = r.state.after?.[key]?.text ?? null;
            if (a !== b) console.log(`[notes.${key}] ${b ?? "(empty)"}\n${" ".repeat(14)}→ ${a ?? "(cleared)"}`);
        }
    }
}

if (ownDatabase) await db.dropDatabase();
process.exit(failed.length ? 1 : 0);
