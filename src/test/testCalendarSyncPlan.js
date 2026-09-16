/**
 * Hand-run:  node src/test/testCalendarSyncPlan.js
 *
 * The decision half of the calendar sync: which events to insert, patch or
 * remove for a day. Pure — no database, no network, no .env — so it runs in
 * npm test. The end-to-end replay against Mongo is testScheduleUpdateLocal.js.
 */
import assert from "node:assert";
import { planDaySync, slotEvent, listDayEvents, deleteEvent, TAG } from "../connectors/gCalendar/calendarEvents.js";

const TZ = "Asia/Kolkata";
const DATE = "2026-09-14";
const tests = [];
const test = (n, f) => tests.push([n, f]);

const slot = (slotId, startTime, endTime, title, status = "Planned", notes = null) =>
    ({ slotId, startTime, endTime, title, status, notes });

// The shape Google hands back: an id, a created stamp, and dateTimes with an offset.
function fromGoogle(body, id, created) {
    const off = (p) => ({ ...p, dateTime: `${p.dateTime}+05:30` });
    return { ...body, id, created, start: off(body.start), end: off(body.end) };
}

const DAY = [
    slot("slot_1", "13:30", "14:30", "Lunch & Rest"),
    slot("slot_2", "14:30", "15:30", "Thread dump"),
    slot("slot_8", "23:00", "00:00", "Watch Loki"),
];

test("a fresh day inserts every slot and nothing else", () => {
    const plan = planDaySync(DATE, DAY, [], TZ);
    assert.strictEqual(plan.insert.length, 3);
    assert.deepStrictEqual([plan.patch.length, plan.remove.length, plan.unchanged], [0, 0, 0]);
});

test("every event carries the owner, day and slot tags", () => {
    const e = slotEvent(DATE, DAY[0], TZ);
    assert.deepStrictEqual(e.extendedProperties.private, {
        [TAG.owner]: "1", [TAG.date]: DATE, [TAG.slot]: "slot_1",
    });
});

test("a slot ending at or before its start ends the next day", () => {
    assert.strictEqual(slotEvent(DATE, DAY[2], TZ).end.dateTime, "2026-09-15T00:00:00");
    assert.strictEqual(slotEvent(DATE, slot("s", "22:00", "01:30", "Late"), TZ).end.dateTime, "2026-09-15T01:30:00");
    assert.strictEqual(slotEvent("2026-09-30", slot("s", "23:30", "00:30", "Late"), TZ).end.dateTime, "2026-10-01T00:30:00");
    assert.strictEqual(slotEvent(DATE, DAY[0], TZ).end.dateTime, "2026-09-14T14:30:00");
});

test("Skipped and Rescheduled stay off the calendar; Done and InProgress stay on", () => {
    const plan = planDaySync(DATE, [
        slot("a", "10:00", "11:00", "A", "Skipped"),
        slot("b", "11:00", "12:00", "B", "Rescheduled"),
        slot("c", "12:00", "13:00", "C", "Done"),
        slot("d", "13:00", "14:00", "D", "InProgress"),
    ], [], TZ);
    assert.deepStrictEqual(plan.insert.map(e => e.summary), ["C", "D"]);
});

test("a second run over what Google returned does nothing", () => {
    const first = planDaySync(DATE, DAY, [], TZ);
    const existing = first.insert.map((b, i) => fromGoogle(b, `e${i}`, `2026-09-14T08:0${i}:00Z`));
    const again = planDaySync(DATE, DAY, existing, TZ);
    assert.deepStrictEqual([again.insert.length, again.patch.length, again.remove.length, again.unchanged], [0, 0, 0, 3]);
});

test("an event without our tag is never touched, even if handed in", () => {
    const mine = { id: "mine", summary: "Dentist", start: { dateTime: "2026-09-14T16:00:00+05:30" }, end: { dateTime: "2026-09-14T16:30:00+05:30" } };
    const plan = planDaySync(DATE, [], [mine], TZ);
    assert.deepStrictEqual(plan.remove, []);
    assert.deepStrictEqual(plan.patch, []);
});

test("a moved, renamed or re-noted slot is patched in place, keeping its event id", () => {
    const existing = planDaySync(DATE, DAY, [], TZ).insert.map((b, i) => fromGoogle(b, `e${i}`, `2026-09-14T08:0${i}:00Z`));
    const changed = [
        { ...DAY[0], startTime: "13:45" },
        { ...DAY[1], title: "Thread and heap dump" },
        { ...DAY[2], notes: "one episode" },
    ];
    const plan = planDaySync(DATE, changed, existing, TZ);
    assert.deepStrictEqual(plan.patch.map(p => p.id), ["e0", "e1", "e2"]);
    assert.deepStrictEqual([plan.insert.length, plan.remove.length], [0, 0]);
});

test("our event for a slot that is gone, or now Skipped, is removed", () => {
    const existing = planDaySync(DATE, DAY, [], TZ).insert.map((b, i) => fromGoogle(b, `e${i}`, `2026-09-14T08:0${i}:00Z`));
    const plan = planDaySync(DATE, [DAY[0], { ...DAY[1], status: "Skipped" }], existing, TZ);
    assert.deepStrictEqual(plan.remove.sort(), ["e1", "e2"]);
    assert.strictEqual(plan.unchanged, 1);
});

test("two events for one slot keep the oldest and remove the rest", () => {
    const body = slotEvent(DATE, DAY[0], TZ);
    const plan = planDaySync(DATE, [DAY[0]], [
        fromGoogle(body, "newer", "2026-09-14T09:00:00Z"),
        fromGoogle(body, "older", "2026-09-14T08:00:00Z"),
    ], TZ);
    assert.deepStrictEqual(plan.remove, ["newer"]);
    assert.strictEqual(plan.unchanged, 1);
});

test("listing filters on owner AND day, server-side", async () => {
    const seen = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        seen.push(new URL(url));
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    try {
        await listDayEvents("token", DATE);
    } finally {
        globalThis.fetch = real;
    }
    assert.deepStrictEqual(seen[0].searchParams.getAll("privateExtendedProperty"), [`${TAG.owner}=1`, `${TAG.date}=${DATE}`]);
    assert.strictEqual(seen[0].searchParams.get("singleEvents"), "true");
});

test("deleting an event that is already gone counts as done", async () => {
    const real = globalThis.fetch;
    for (const status of [404, 410]) {
        globalThis.fetch = async () => new Response(null, { status });
        try {
            assert.strictEqual((await deleteEvent("token", "x")).ok, true, `status ${status}`);
        } finally {
            globalThis.fetch = real;
        }
    }
});

let passed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`FAIL  ${name}\n      ${err.message}`);
    }
}
console.log(`\n${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
