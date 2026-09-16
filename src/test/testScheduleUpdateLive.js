/**
 * Hand-run:  node src/test/testScheduleUpdateLive.js [--repeat N]   (needs a local mongod + LLM keys)
 *
 * The same 2026-09-14 turn as testScheduleUpdateLocal.js, but the MODEL decides
 * what to call. Today's schedule is locked in, the lock-in exchange is in the
 * chat history, and the user sends the message they actually sent:
 *
 *   "Okk also can you update this once?? In night at 11-12 I want to see one episode of loki"
 *
 * That day the model called insertSchedule a second time. This checks it now
 * reaches updateSchedule, and that the database and the calendar end up the way
 * the user meant. Real LLM calls, so real quota and real non-determinism — use
 * --repeat before trusting a single pass. MongoDB is local and Google Calendar
 * is faked; the LLM providers are the only network calls allowed out.
 */
import assert from "node:assert";
import { useLocalMongo } from "./support/localMongo.js";
import { installFakeGoogleCalendar } from "./support/fakeGoogleCalendar.js";

const repeatAt = process.argv.indexOf("--repeat");
const REPEAT = repeatAt > -1 ? Math.max(1, Number(process.argv[repeatAt + 1]) || 1) : 1;

await useLocalMongo("rasmalai-schedule-live");
const calendar = installFakeGoogleCalendar({ passthrough: true });

const { getDB, ensureIndexes } = await import("../tools/mongo/mongoClient.js");
const { runWithUserContext } = await import("../identity/userContext.js");
const { runAgent } = await import("../agent/agent.js");
const { insertSchedule } = await import("../tools/mongo/operation/insertSchedule.js");
const { whenCalendarSynced } = await import("../connectors/gCalendar/syncScheduleDay.js");
const { localDateOf } = await import("../tools/mongo/dateUtils.js");

const USER_ID = 7;
const MESSAGE = "Okk also can you update this once?? In night at 11-12 I want to see one episode of loki";

const LOCKED = [
    ["13:30", "14:30", "Routine: Lunch & Rest"],
    ["14:30", "15:30", "Progress in thread dump and heap dump"],
    ["15:30", "16:30", "Raise PR for e_interface and debug ai_agent_teams admin access"],
    ["16:30", "18:30", "Complete Docker (part of Kubernetes) from Harkirat"],
    ["18:30", "19:30", "Bappa ke Darshan"],
    ["19:30", "20:00", "Complete Docker (part of Kubernetes) from Harkirat"],
    ["20:00", "21:30", "Routine: Dinner & Wind-down"],
].map(([startTime, endTime, title], i) => ({ slotId: `slot_${i + 1}`, startTime, endTime, title, status: "Planned" }));

const db = await getDB();

async function seed(today) {
    await db.dropDatabase();
    await ensureIndexes();
    calendar.reset();

    const now = new Date();
    await db.collection("users").insertOne({
        userId: USER_ID, name: "Rhythm", timezone: "Asia/Kolkata", status: "active",
        preferences: { triggersOptIn: false }, createdAt: now, updatedAt: now,
    });
    await db.collection("connection").insertOne({
        userId: USER_ID, appName: "gCalendar", status: "ACTIVE",
        access_token: "fake", refresh_token: "fake", expiresAt: Date.now() + 3600_000,
        createdAt: Date.now(), updatedAt: Date.now(),
    });
    const dentist = calendar.addUserEvent({
        summary: "Dentist — made by the user",
        start: { dateTime: `${today}T16:00:00+05:30` },
        end: { dateTime: `${today}T16:30:00+05:30` },
    });

    const locked = await insertSchedule(USER_ID, today, LOCKED, "Ganesh Chaturthi plan", "Have a blessed day.");
    assert.strictEqual(locked.success, true, `seeding the locked-in schedule failed: ${locked.error}`);
    await whenCalendarSynced(USER_ID);

    // The lock-in exchange the user was replying to — without it "update this" has no referent.
    await db.collection("chatHistory").insertOne({
        conversationId: "seed-lock-in", userId: USER_ID, source: "telegram", createdAt: new Date(Date.now() - 120_000),
        messages: [
            { role: "user", content: "okk that is perfect. lock it in", timestamp: new Date(Date.now() - 125_000) },
            { role: "assistant", content: "*Schedule locked in* — have a wonderful and blessed day.", timestamp: new Date(Date.now() - 120_000) },
        ],
    });
    return { dentist, dentistBefore: JSON.stringify(calendar.events.get(dentist)) };
}

async function runOnce(n) {
    const today = localDateOf(new Date());
    const { dentist, dentistBefore } = await seed(today);

    const { text, metrics } = await runWithUserContext(
        { userId: USER_ID, channel: "telegram", address: null },
        () => runAgent(USER_ID, MESSAGE)
    );
    await whenCalendarSynced(USER_ID);

    const turn = await db.collection("chatHistory")
        .find({ userId: USER_ID, conversationId: { $ne: "seed-lock-in" } })
        .sort({ createdAt: -1 }).limit(1).next();
    const trace = [];
    for (const m of turn?.messages ?? []) {
        if (m.functionCalls) for (const f of m.functionCalls) trace.push({ name: f.name, args: f.args });
        if (m.role === "tool") {
            const open = [...trace].reverse().find(t => t.name === m.toolName && t.ok === undefined);
            if (open) Object.assign(open, { ok: m.result?.success !== false, message: m.result?.message });
        }
    }

    console.log(`\n── run ${n}/${REPEAT} ─────────────────────────────────────────────`);
    for (const t of trace) {
        console.log(`  ${t.ok ? "ok  " : "FAIL"} ${t.name}${t.name.endsWith("Schedule") ? ` ${JSON.stringify(t.args)}` : ""}`);
        if (!t.ok) console.log(`       ${String(t.message).slice(0, 200)}`);
    }
    console.log(`  reply: ${String(text).replace(/\n/g, " ").slice(0, 240)}`);
    console.log(`  cost : ${metrics.calls} calls on ${metrics.models.join(", ")}, ${metrics.tokens.total} tokens`);

    const docs = await db.collection("userSchedule").find({ userId: USER_ID }).toArray();
    const loki = docs[0]?.slots.find(s => /loki/i.test(s.title));
    const visible = (docs[0]?.slots ?? []).filter(s => !["Skipped", "Rescheduled"].includes(s.status));
    const tagged = calendar.tagged(today);
    const perSlot = new Map();
    for (const e of tagged) {
        const id = e.extendedProperties.private.rasmalaiSlotId;
        perSlot.set(id, (perSlot.get(id) ?? 0) + 1);
    }

    const checks = [
        ["called updateSchedule, and it succeeded", () =>
            assert.ok(trace.some(t => t.name === "updateSchedule" && t.ok), "no successful updateSchedule call")],
        ["no second schedule was inserted", () =>
            assert.ok(!trace.some(t => t.name === "insertSchedule" && t.ok), "insertSchedule succeeded again")],
        ["still exactly one schedule for today", () => assert.strictEqual(docs.length, 1)],
        ["Loki is on the day, 23:00 to 00:00", () => {
            assert.ok(loki, "no Loki slot on the day");
            assert.deepStrictEqual([loki.startTime, loki.endTime], ["23:00", "00:00"]);
        }],
        ["the calendar has one event per slot and nothing extra", () => {
            assert.strictEqual(tagged.length, visible.length, `${tagged.length} events for ${visible.length} slots`);
            assert.ok([...perSlot.values()].every(c => c === 1), "a slot has more than one event");
        }],
        ["Loki's event ends at midnight the next day", () => {
            const event = tagged.find(e => e.extendedProperties.private.rasmalaiSlotId === loki?.slotId);
            assert.ok(event, "no calendar event for the Loki slot");
            assert.match(event.end.dateTime, /T00:00:00\+05:30$/);
            assert.notStrictEqual(event.end.dateTime.slice(0, 10), today);
        }],
        ["the user's own event was not touched", () =>
            assert.strictEqual(JSON.stringify(calendar.events.get(dentist)), dentistBefore)],
        ["the reply tells them Loki is in", () => assert.match(String(text), /loki/i)],
    ];

    let ok = 0;
    for (const [name, fn] of checks) {
        try {
            fn();
            console.log(`  PASS  ${name}`);
            ok++;
        } catch (err) {
            console.log(`  FAIL  ${name} — ${err.message}`);
        }
    }
    return ok === checks.length;
}

let clean = 0;
for (let i = 1; i <= REPEAT; i++) {
    if (await runOnce(i)) clean++;
    // Stay under the per-minute limit of the primary model between runs.
    if (i < REPEAT) await new Promise(r => setTimeout(r, 20_000));
}
calendar.restore();
console.log(`\n${clean}/${REPEAT} runs fully correct`);
process.exit(clean === REPEAT ? 0 : 1);
