/**
 * Hand-run:  node src/test/testScheduleUpdateLocal.js   (needs a local mongod)
 *
 * Replays 2026-09-14 against a LOCAL MongoDB and a fake Google Calendar, through
 * the real tool registry — no LLM. That day the schedule was locked in at 13:29,
 * then at 13:37 the user asked for "Watch Loki, 23:00-00:00". The agent called
 * insertSchedule again: it succeeded as a rival schedule, the calendar sync
 * pushed the first schedule a second time, and Loki never reached the calendar.
 *
 * Each step below is one thing that went wrong that day, or one guarantee the
 * fix makes. Steps share state, so the first failure skips the rest.
 */
import assert from "node:assert";
import { useLocalMongo } from "./support/localMongo.js";
import { installFakeGoogleCalendar } from "./support/fakeGoogleCalendar.js";

await useLocalMongo("rasmalai-schedule-local");
const calendar = installFakeGoogleCalendar();

const { getDB, ensureIndexes } = await import("../tools/mongo/mongoClient.js");
const { runWithUserContext } = await import("../identity/userContext.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;
const { whenCalendarSynced } = await import("../connectors/gCalendar/syncScheduleDay.js");
const { syncScheduleToCalendar } = await import("../connectors/gCalendar/syncScheduleToCalendar.js");

const USER_ID = 7;
const DATE = "2026-09-14";

// The schedule exactly as it was locked in at 13:29 that day.
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
await db.dropDatabase();
await ensureIndexes();
await db.collection("connection").insertOne({
    userId: USER_ID, appName: "gCalendar", status: "ACTIVE",
    access_token: "fake", refresh_token: "fake", expiresAt: Date.now() + 3600_000,
    createdAt: Date.now(), updatedAt: Date.now(),
});
const DENTIST = calendar.addUserEvent({
    summary: "Dentist — made by the user, not Rasmalai",
    start: { dateTime: "2026-09-14T16:00:00+05:30" },
    end: { dateTime: "2026-09-14T16:30:00+05:30" },
});
const dentistBefore = JSON.stringify(calendar.events.get(DENTIST));

const call = (name, args) =>
    runWithUserContext({ userId: USER_ID, channel: "test" }, () => toolRegistry.execute(name, args));
const settled = () => whenCalendarSynced(USER_ID);
const schedules = () => db.collection("userSchedule").find({ userId: USER_ID }).toArray();
const eventFor = (slotId) => calendar.tagged(DATE).filter(e => e.extendedProperties.private.rasmalaiSlotId === slotId);
const writesSince = (mark) => calendar.writes.slice(mark);

const steps = [];
const step = (n, f) => steps.push([n, f]);

step("13:29 — locking the day in puts every slot on the calendar, tagged", async () => {
    const res = await call("insertSchedule", { date: DATE, slots: LOCKED });
    assert.strictEqual(res.success, true, res.message);
    await settled();
    assert.strictEqual(calendar.tagged(DATE).length, 7);
    for (const s of LOCKED) assert.strictEqual(eventFor(s.slotId).length, 1, `${s.slotId} should have exactly one event`);
});

step("13:37 — locking the day in AGAIN is refused, and the calendar does not move", async () => {
    const mark = calendar.writes.length;
    const res = await call("insertSchedule", {
        date: DATE,
        slots: [...LOCKED, { slotId: "slot_8", startTime: "23:00", endTime: "00:00", title: "Watch Loki" }],
    });
    await settled();
    assert.strictEqual(res.success, false, "a second schedule for the day must not be inserted");
    assert.match(res.message, /updateSchedule/, "the refusal has to name the tool that works");
    assert.strictEqual((await schedules()).length, 1, "still exactly one schedule for the day");
    assert.deepStrictEqual(writesSince(mark), [], "no calendar writes — this is what duplicated seven events");
});

step("the fix — updateSchedule adds Loki, and the calendar gains exactly that one event", async () => {
    const mark = calendar.writes.length;
    const res = await call("updateSchedule", {
        date: DATE,
        add: [{ startTime: "23:00", endTime: "00:00", title: "Watch Loki", category: "Personal" }],
    });
    await settled();
    assert.strictEqual(res.success, true, res.message);

    const [doc] = await schedules();
    const loki = doc.slots.find(s => /loki/i.test(s.title));
    assert.deepStrictEqual([loki.slotId, loki.startTime, loki.endTime], ["slot_8", "23:00", "00:00"]);

    assert.deepStrictEqual(writesSince(mark).map(w => w.method), ["POST"]);
    const [event] = eventFor("slot_8");
    assert.strictEqual(event.end.dateTime, "2026-09-15T00:00:00+05:30", "23:00-00:00 must end the next day, or Google rejects it");
    assert.strictEqual(calendar.tagged(DATE).length, 8);
});

step("an edit patches the same event; Skipped takes one off the calendar but not off the day", async () => {
    const lunchId = eventFor("slot_1")[0].id;
    const res = await call("updateSchedule", {
        date: DATE,
        update: [
            { slotId: "slot_1", title: "Lunch & Rest", endTime: "14:15" },
            { slotId: "slot_3", status: "Skipped" },
        ],
    });
    await settled();
    assert.strictEqual(res.success, true, res.message);

    const [lunch] = eventFor("slot_1");
    assert.strictEqual(lunch.id, lunchId, "an edited slot keeps its event id");
    assert.strictEqual(lunch.summary, "Lunch & Rest");
    assert.strictEqual(lunch.end.dateTime, "2026-09-14T14:15:00+05:30");
    assert.strictEqual(eventFor("slot_3").length, 0, "a Skipped slot leaves the calendar");

    const [doc] = await schedules();
    assert.strictEqual(doc.slots.find(s => s.slotId === "slot_3").status, "Skipped", "but stays on the day's record");
    const ids = doc.slots.map(s => s.slotId);
    assert.strictEqual(ids.length, 8, "Skipped changes a slot in place — it never adds one");
    assert.strictEqual(new Set(ids).size, ids.length, "every slotId on the day is still unique");
});

step("a sync with nothing to change writes nothing", async () => {
    const mark = calendar.writes.length;
    await syncScheduleToCalendar(USER_ID, DATE);
    await syncScheduleToCalendar(USER_ID, DATE);
    assert.deepStrictEqual(writesSince(mark), []);
});

step("syncs fired together never duplicate an event", async () => {
    calendar.events.delete(eventFor("slot_8")[0].id);
    const mark = calendar.writes.length;
    syncScheduleToCalendar(USER_ID, DATE);
    syncScheduleToCalendar(USER_ID, DATE);
    syncScheduleToCalendar(USER_ID, DATE);
    await settled();
    assert.deepStrictEqual(writesSince(mark).map(w => w.method), ["POST"], "three syncs, one insert");
    assert.strictEqual(eventFor("slot_8").length, 1);
});

step("a leftover duplicate from an interrupted sync is cleaned up", async () => {
    const [original] = eventFor("slot_2");
    const { id, created, ...copy } = original;
    calendar.inject(copy);
    assert.strictEqual(eventFor("slot_2").length, 2);
    await syncScheduleToCalendar(USER_ID, DATE);
    const left = eventFor("slot_2");
    assert.deepStrictEqual(left.map(e => e.id), [original.id], "the original survives, the copy goes");
});

step("an unknown slotId is refused, lists the real slots, and moves nothing", async () => {
    const mark = calendar.writes.length;
    const [before] = await schedules();
    const res = await call("updateSchedule", { date: DATE, update: [{ slotId: "slot_99", status: "Done" }] });
    await settled();
    assert.strictEqual(res.success, false);
    assert.match(res.message, /slot_8 23:00-00:00 Watch Loki/, "the refusal hands back real slotIds");
    const [after] = await schedules();
    assert.deepStrictEqual(after.slots, before.slots);
    assert.deepStrictEqual(writesSince(mark), []);
});

step("a schedule whose slots share or lack a slotId is refused before anything is written", async () => {
    const other = "2026-09-15";
    const repeated = await call("insertSchedule", { date: other, slots: [
        { slotId: "slot_1", startTime: "10:00", endTime: "11:00", title: "A" },
        { slotId: "slot_1", startTime: "11:00", endTime: "12:00", title: "B" },
    ] });
    assert.strictEqual(repeated.success, false);
    assert.match(repeated.message, /slot_1 is used more than once/);
    const unnamed = await call("insertSchedule", { date: other, slots: [{ startTime: "10:00", endTime: "11:00", title: "A" }] });
    assert.strictEqual(unnamed.success, false);
    assert.match(unnamed.message, /no slotId/);
    assert.strictEqual((await schedules()).length, 1, "no schedule was created for the 15th");
});

step("updateRecords cannot rewrite the day behind the calendar's back", async () => {
    const [doc] = await schedules();
    const res = await call("updateRecords", {
        records: [{ collectionName: "userSchedule", id: String(doc._id), data: { slots: [] } }],
    });
    assert.strictEqual(res.success, false);
    assert.match(res.message, /updateSchedule/);
    assert.strictEqual((await schedules())[0].slots.length, 8);
});

step("the user's own event was never read into a change, patched or deleted", async () => {
    assert.strictEqual(JSON.stringify(calendar.events.get(DENTIST)), dentistBefore);
    assert.ok(!calendar.writes.some(w => w.id === DENTIST));
});

let passed = 0;
let stopped = false;
for (const [name, fn] of steps) {
    if (stopped) {
        console.log(`SKIP  ${name}`);
        continue;
    }
    try {
        await fn();
        console.log(`PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`FAIL  ${name}\n      ${err.message}`);
        stopped = true;
    }
}
calendar.restore();
console.log(`\n${passed}/${steps.length} passed`);
process.exit(passed === steps.length ? 0 : 1);
