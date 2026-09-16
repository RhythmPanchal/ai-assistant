/**
 * Hand-run:  node src/test/eval/evalNightRoutine.js
 *            node src/test/eval/evalNightRoutine.js --only meals-across-turns --show
 *            node src/test/eval/evalNightRoutine.js --repeat 2
 *
 * Plays each scenario in nightScenarios.js through the real night routine —
 * the real opener, runAgent, the real tools — and then checks what actually
 * landed in the database.
 *
 * THIS WRITES TO MONGO — into its own database, `Rasmalai-eval` by default
 * (override with --db), never the one .env names. Two reasons, the second
 * learned the hard way. It keeps eval rows out of real data. And it is the only
 * way to grade against prod's constraints: prod has unique (userId, date)
 * indexes on the day registers, the dev database cannot build them because it
 * already holds duplicate rows, and the first baseline run there reported
 * "three diet docs for one day" — a failure prod would have refused outright.
 * A fresh database builds every index cleanly.
 *
 * Everything is filed under EVAL_USER_ID and deleted before and after every
 * scenario (--keep leaves the last one in place to inspect). A database whose
 * name contains "prod" is refused.
 *
 * Nothing is sent to Telegram. The opener is produced the way the job produces
 * it, but returned here instead of delivered.
 */
import "dotenv/config";
import { getDB, ensureIndexes } from "../../tools/mongo/mongoClient.js";
import { ensureFactKeys } from "../../tools/mongo/operation/userFacts.js";
import { runAsSystem } from "../../identity/userContext.js";
import { runAgent } from "../../agent/agent.js";
import { runWithUserContext } from "../../identity/userContext.js";
import { openFlow } from "../../scheduler/flows/activeFlowsRepo.js";
import goodNightFlow from "../../agent/flows/goodNightFlow.js";
import { localDateOf, localDayRange, IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";
import { NIGHT_SCENARIOS } from "./nightScenarios.js";

// Far above anything the counter allocates, and checked against `users` below.
const EVAL_USER_ID = 900001;
const TIME_ZONE = IST_TIMEZONE;

// Your cap for a whole wrap-up, opener included.
const MAX_QUESTIONS = 10;

const CLEANUP = [
    "dietRegister", "taskRegister", "expenseRegister", "chatHistory", "activeFlows",
    "triggerJob", "chatSummary", "userFact", "llmUsage", "taskCalendar", "userSchedule",
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const repeat = Number(flag("repeat", 1));

// Read lazily by getDB() on first use, so setting it here — after dotenv has
// loaded .env — is enough to redirect every module in this process.
process.env.MONGODB_DB_NAME = flag("db", "Rasmalai-eval");
const only = flag("only", null);
const show = args.includes("--show");
const keep = args.includes("--keep");

const db = await getDB();
if (/prod/i.test(db.databaseName)) {
    console.error(`Refusing to run against "${db.databaseName}". This eval writes rows; point .env at the dev database.`);
    process.exit(1);
}
const collision = await db.collection("users").findOne({ userId: EVAL_USER_ID });
if (collision && !collision.evalUser) {
    console.error(`userId ${EVAL_USER_ID} belongs to a real user in ${db.databaseName}. Pick another EVAL_USER_ID.`);
    process.exit(1);
}

// Everything the service builds at boot, so the eval database refuses what
// prod refuses — above all a second day-register document for one day.
await ensureIndexes();
await runAsSystem("night-eval", () => ensureFactKeys());

const scenarios = only ? NIGHT_SCENARIOS.filter(s => s.name === only) : NIGHT_SCENARIOS;
if (!scenarios.length) {
    console.error(`No scenario "${only}". Known: ${NIGHT_SCENARIOS.map(s => s.name).join(", ")}`);
    process.exit(1);
}

async function cleanup() {
    await Promise.all(CLEANUP.map(c => db.collection(c).deleteMany({ userId: EVAL_USER_ID })));
}

/**
 * Today's context, written straight to the collections — never through the
 * code under test. Chat turns are spaced a few minutes apart ending just before
 * now, so they are today, in the past, and in order: history is replayed
 * oldest first, and a seeded turn stamped after the real conversation would be
 * read as coming after it.
 */
async function seed(scenario, logDate) {
    const { start } = localDayRange(logDate);
    const now = Date.now();
    const chat = scenario.seed?.chat ?? [];

    for (const [i, turn] of chat.entries()) {
        const at = new Date(Math.max(start.getTime() + (i + 1) * 1000, now - (chat.length - i) * 5 * 60 * 1000));
        await db.collection("chatHistory").insertOne({
            conversationId: `eval-${scenario.name}-${i}`,
            userId: EVAL_USER_ID,
            source: "telegram",
            messages: [
                { role: "user", content: turn.user, timestamp: at },
                { role: "assistant", content: turn.assistant, timestamp: at },
            ],
            createdAt: at,
        });
    }

    const meals = (scenario.seed?.meals ?? []).map(m => ({
        mealType: m.mealType,
        items: m.items,
        mealCalories: m.items.reduce((n, x) => n + x.calories, 0),
    }));
    if (meals.length) {
        const d = new Date(`${logDate}T00:00:00+05:30`);
        await db.collection("dietRegister").insertOne({
            userId: EVAL_USER_ID,
            date: start,
            month: d.toLocaleDateString("en-GB", { timeZone: TIME_ZONE, month: "long" }),
            year: Number(logDate.slice(0, 4)),
            meals,
            dailyTotals: { caloriesConsumed: meals.reduce((n, m) => n + m.mealCalories, 0), protein: 0, carbs: 0, fat: 0 },
            createdAt: new Date(),
        });
    }

    for (const e of scenario.seed?.expenses ?? []) {
        const d = new Date(`${logDate}T00:00:00+05:30`);
        await db.collection("expenseRegister").insertOne({
            userId: EVAL_USER_ID, ...e, date: start,
            month: d.toLocaleDateString("en-GB", { timeZone: TIME_ZONE, month: "long" }),
            year: Number(logDate.slice(0, 4)),
            createdAt: new Date(),
        });
    }
}

/**
 * The opener exactly as the job would send it. Falls back to the fixed
 * template when the job has no composer — which is what makes this same file
 * a baseline against the routine as it was before the opener was generated.
 */
async function produceOpener() {
    const job = await import("../../scheduler/jobs/goodNightJob.js");
    if (typeof job.composeNightOpener === "function") {
        const { text, generated } = await job.composeNightOpener(EVAL_USER_ID, TIME_ZONE);
        return { text, generated };
    }
    return { text: goodNightFlow.openerMessage, generated: false };
}

async function readState(logDate) {
    const { start, end } = localDayRange(logDate);
    const day = { userId: EVAL_USER_ID, date: { $gte: start, $lt: end } };
    const otherDays = { userId: EVAL_USER_ID, date: { $not: { $gte: start, $lt: end } } };

    const [diet, tasks, expenses, strays, flow] = await Promise.all([
        db.collection("dietRegister").find(day).toArray(),
        db.collection("taskRegister").find(day).toArray(),
        db.collection("expenseRegister").find(day).toArray(),
        Promise.all(["dietRegister", "taskRegister", "expenseRegister"].map(c => db.collection(c).countDocuments(otherDays))),
        db.collection("activeFlows").find({ userId: EVAL_USER_ID, flowType: "goodNight" }).sort({ startedAt: -1 }).limit(1).next(),
    ]);

    return {
        diet, tasks, expenses, flow,
        meals: diet.flatMap(d => d.meals ?? []),
        performed: tasks.flatMap(t => t.performedTasks ?? []),
        strayRows: strays.reduce((a, b) => a + b, 0),
    };
}

// Held by every scenario. These are the invariants a wrap-up must never break,
// whatever the conversation was about.
const GLOBAL_CHECKS = [
    { why: "nothing written to any day but the one being wrapped up", fn: s => s.strayRows === 0, detail: s => `${s.strayRows} row(s) on other days` },
    { why: "at most one diet doc and one task doc for the day", fn: s => s.diet.length <= 1 && s.tasks.length <= 1, detail: s => `${s.diet.length} diet, ${s.tasks.length} task docs` },
    {
        why: "the day's calorie total equals the sum of its meals",
        fn: s => s.diet.every(d => (d.dailyTotals?.caloriesConsumed ?? -1) === (d.meals ?? []).reduce((n, m) => n + (m.mealCalories ?? 0), 0)),
        detail: s => s.diet.map(d => `stored ${d.dailyTotals?.caloriesConsumed} vs meals ${(d.meals ?? []).reduce((n, m) => n + (m.mealCalories ?? 0), 0)}`).join("; "),
    },
    { why: `no more than ${MAX_QUESTIONS} questions across the whole wrap-up`, fn: s => s.questions <= MAX_QUESTIONS, detail: s => `${s.questions} questions` },
    { why: "every turn got a reply", fn: s => s.turns.every(t => t.agent && t.agent.trim()), detail: s => `${s.turns.filter(t => !t.agent?.trim()).length} empty` },
];

const results = [];

for (const scenario of scenarios) {
    for (let run = 1; run <= repeat; run++) {
        const record = { name: scenario.name, run, why: scenario.why, turns: [], models: new Set() };
        const started = Date.now();
        await cleanup();

        try {
            const logDate = localDateOf(new Date(), TIME_ZONE);
            await seed(scenario, logDate);
            await openFlow({ userId: EVAL_USER_ID, flowType: goodNightFlow.flowType, expiresAt: goodNightFlow.computeExpiry(TIME_ZONE) });

            const opener = await produceOpener();
            record.opener = opener.text;
            record.generated = opener.generated;

            for (const text of scenario.replies) {
                const out = await runWithUserContext(
                    { userId: EVAL_USER_ID, channel: "eval", reason: `night-eval:${scenario.name}` },
                    () => runAgent(EVAL_USER_ID, text, "telegram")
                );
                const agent = typeof out === "string" ? out : out?.text;
                for (const m of out?.metrics?.models ?? []) record.models.add(m);
                record.turns.push({ user: text, agent });
            }

            const state = await readState(logDate);
            state.opener = record.opener;
            state.turns = record.turns;
            state.questions = [record.opener, ...record.turns.map(t => t.agent)]
                .reduce((n, t) => n + ((t ?? "").match(/\?/g) ?? []).length, 0);

            record.state = state;
            record.checks = [...GLOBAL_CHECKS, ...scenario.checks].map(c => ({
                ok: Boolean(c.fn(state)),
                why: c.why,
                detail: c.detail ? c.detail(state) : undefined,
            }));
        } catch (err) {
            record.error = err.stack ?? err.message;
            record.checks = [];
        } finally {
            record.seconds = Math.round((Date.now() - started) / 1000);
            if (!keep) await cleanup();
        }

        results.push(record);
        const bad = record.error ? "ERROR" : `${record.checks.filter(c => !c.ok).length} failed`;
        console.log(`  ${scenario.name} (run ${run}) — ${bad} — ${record.seconds}s`);
    }
}

// ------------------------------------------------------------------ report --
const pad = (s, n) => String(s).padEnd(n);
const line = "=".repeat(96);
console.log(`\n${line}\nNIGHT ROUTINE EVAL — ${db.databaseName}\n${line}`);
console.log(`${pad("scenario", 22)}${pad("run", 5)}${pad("opener", 11)}${pad("turns", 7)}${pad("q's", 5)}${pad("secs", 6)}checks`);
console.log("-".repeat(96));
for (const r of results) {
    if (r.error) { console.log(`${pad(r.name, 22)}${pad(r.run, 5)}ERROR`); continue; }
    const good = r.checks.filter(c => c.ok).length;
    console.log(
        `${pad(r.name, 22)}${pad(r.run, 5)}${pad(r.generated ? "generated" : "template", 11)}` +
        `${pad(r.turns.length, 7)}${pad(r.state.questions, 5)}${pad(r.seconds, 6)}` +
        `${good}/${r.checks.length}${good === r.checks.length ? "" : "  <-"}`
    );
}

const failed = results.filter(r => r.error || r.checks.some(c => !c.ok));
if (failed.length) {
    console.log(`\n${line}\nWHAT FAILED\n${line}`);
    for (const r of failed) {
        console.log(`\n${r.name} (run ${r.run}) — ${r.why}`);
        if (r.error) { console.log(`  ERROR: ${r.error}`); continue; }
        for (const c of r.checks.filter(x => !x.ok)) {
            console.log(`  ✗ ${c.why}`);
            if (c.detail) console.log(`      got: ${String(c.detail).slice(0, 300)}`);
        }
    }
}

if (show) {
    console.log(`\n${line}\nCONVERSATIONS\n${line}`);
    for (const r of results.filter(x => !x.error)) {
        console.log(`\n--- ${r.name} (run ${r.run}) · models: ${[...r.models].join(", ") || "?"} ---`);
        console.log(`RASMALAI: ${r.opener}`);
        for (const t of r.turns) console.log(`USER:     ${t.user}\nRASMALAI: ${t.agent}`);
        console.log(`[db] meals: ${r.state.meals.map(m => `${m.mealType}(${m.items.map(i => i.name).join("+")})`).join(", ") || "none"}`);
        console.log(`[db] expenses: ${r.state.expenses.map(e => `₹${e.amount} ${e.category}`).join(", ") || "none"}`);
        console.log(`[db] tasks: ${r.state.performed.map(t => t.title).join(", ") || "none"}`);
    }
}

const checks = results.flatMap(r => r.checks);
console.log(`\n${"-".repeat(96)}`);
console.log(
    `${results.length - failed.length}/${results.length} scenarios fully clean · ` +
    `${checks.filter(c => c.ok).length}/${checks.length} checks passed`
);
process.exit(failed.length ? 1 : 0);
