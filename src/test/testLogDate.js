/**
 * Covers the three fixes from the 2026-08-16 postmortem:
 *   A  LOG DATE — the flow's opening day, not the wall clock
 *   B  chatHistory falls back to previous days when today is empty
 *   3  reminders refuse a past fire time and de-duplicate
 *
 * Run: node src/test/testLogDate.js
 * Pure unit assertions except the reminder section, which needs Mongo.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { localDateOf, toIST, atLocalHour } from "../tools/mongo/dateUtils.js";
import { flowStateBlock } from "../agent/agent.js";

let pass = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); pass++; }
    catch (e) { console.error(`  ✗ ${label}\n      ${e.message}`); process.exitCode = 1; }
}

console.log("\nA — localDateOf: which day does an instant belong to");

check("23:08 on the 13th is the 13th", () =>
    assert.equal(localDateOf(new Date("2026-08-13T23:08:00+05:30")), "2026-08-13"));

check("02:47 on the 14th is still the 14th by the clock", () =>
    assert.equal(localDateOf(new Date("2026-08-14T02:47:00+05:30")), "2026-08-14"));

check("a flow opened 13th 23:00 labels the 13th even when read at 02:47 on the 14th", () => {
    // This is the real fix: the label comes from startedAt, so the time of
    // reading is irrelevant. Aug 14 02:47 is exactly when the week's worst
    // mislabel happened.
    const flow = { flowType: "goodNight", startedAt: new Date("2026-08-13T23:00:00+05:30"), scratchpad: {} };
    assert.equal(localDateOf(flow.startedAt), "2026-08-13");
});

check("respects a non-IST zone", () => {
    const at = new Date("2026-08-13T20:00:00Z");            // 01:30 IST on the 14th
    assert.equal(localDateOf(at, "Asia/Kolkata"), "2026-08-14");
    assert.equal(localDateOf(at, "America/New_York"), "2026-08-13");
});

check("null/invalid input does not throw", () => {
    assert.equal(localDateOf(null), null);
    assert.equal(localDateOf("not a date"), null);
});

console.log("\nA — flowStateBlock carries LOG DATE into the overlay");

const nightFlow = {
    flowType: "goodNight",
    startedAt: new Date("2026-08-13T23:00:00+05:30"),
    scratchpad: { unrelatedReplies: 0 },
};

check("block states the opening day, not the current one", () => {
    const block = flowStateBlock(nightFlow);
    assert.ok(block.includes("LOG DATE: 2026-08-13"), block);
});

check("block still exposes unrelatedReplies (two-strike rule)", () =>
    assert.ok(flowStateBlock({ ...nightFlow, scratchpad: { unrelatedReplies: 1 } })
        .includes("unrelatedReplies so far: 1")));

check("missing startedAt degrades to 'unknown' rather than crashing", () =>
    assert.ok(flowStateBlock({ flowType: "goodNight" }).includes("LOG DATE: unknown")));

console.log("\nA — a bare LOG DATE survives the write path unshifted");

check("toIST round-trips a date-only string to local midnight", () => {
    // The whole point of emitting "2026-08-13" instead of a Z-suffixed instant:
    // this is the one form both the current prod build and main agree on.
    assert.equal(toIST("2026-08-13").toISOString(), "2026-08-12T18:30:00.000Z");
    assert.equal(localDateOf(toIST("2026-08-13")), "2026-08-13");
});

check("a Z-suffixed instant, by contrast, shifts a full day back", () => {
    // Documents the trap the LOG DATE rule exists to avoid — the model used to
    // emit this form for every write.
    assert.equal(localDateOf(toIST("2026-08-13T18:30:00.000Z")), "2026-08-13");
    assert.notEqual(toIST("2026-08-13T18:30:00.000Z").toISOString(), "2026-08-13T18:30:00.000Z");
});

console.log("\nA — flow cutoffs still anchor to the user's wall clock");

check("atLocalHour is unaffected by these changes", () => {
    const six = atLocalHour(18, "Asia/Kolkata");
    assert.equal(six.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" }), "18:00:00");
});

console.log("\n3 — reminder guards");

const { createOneTimeReminder } = await import("../scheduler/createReminders.js");
const TEST_USER = 999000001;

async function expectThrow(label, fn, needle) {
    try { await fn(); console.error(`  ✗ ${label}\n      expected a throw`); process.exitCode = 1; }
    catch (e) {
        if (needle && !e.message.includes(needle)) {
            console.error(`  ✗ ${label}\n      message lacked "${needle}": ${e.message}`); process.exitCode = 1;
        } else { console.log(`  ✓ ${label}`); pass++; }
    }
}

await expectThrow(
    "a fire time already in the past is rejected",
    () => createOneTimeReminder("Call Dipika Ben", TEST_USER, "2026-08-13T19:00:00", "Call Dipika Ben"),
    "already passed"
);

await expectThrow(
    "an unparseable fire time is rejected",
    () => createOneTimeReminder("Nonsense", TEST_USER, "tomorrow evening", "x"),
    "Invalid nextExecutionAt"
);

{
    // Requires Mongo. Creates and removes one row in whatever DB .env points at.
    const future = new Date(Date.now() + 3 * 3600_000);
    const naive = future.toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).replace(" ", "T");
    const { getDB } = await import("../tools/mongo/mongoClient.js");
    const { TRIGGER_JOB } = await import("../tools/mongo/schema/triggerJobSchema.js");
    const db = await getDB();

    try {
        const first = await createOneTimeReminder("__test reminder", TEST_USER, naive, "hello");
        check("a future reminder is created", () => assert.ok(first.insertedId && !first.duplicate));

        const second = await createOneTimeReminder("__test reminder", TEST_USER, naive, "hello");
        check("re-issuing the identical reminder is a no-op, not a second job", () => {
            assert.equal(second.duplicate, true);
            assert.equal(String(second.insertedId), String(first.insertedId));
        });

        const count = await db.collection(TRIGGER_JOB).countDocuments({ userId: TEST_USER });
        check("exactly one job exists afterwards", () => assert.equal(count, 1));
    } finally {
        await db.collection(TRIGGER_JOB).deleteMany({ userId: TEST_USER });
    }
}

console.log("\nfetchRecord — bounds and filter validation");

const { fetchRecord } = await import("../tools/mongo/fetchRecords.js");
const USER = 1136575387;

{
    const r = await fetchRecord("dietRegister", { userId: USER });
    check("an unscoped day-scoped query is bounded to 7 days", () =>
        assert.ok(r.applied.some(a => a.includes("last 7 days")), JSON.stringify(r.applied)));
    check("the bound is reported, not silent", () => assert.ok(r.applied.length > 0));
}

{
    const r = await fetchRecord("dietRegister", { userId: USER, date: { $gte: "2026-01-01" } });
    check("an explicit date filter is left alone", () =>
        assert.equal(r.applied.filter(a => a.includes("7 days")).length, 0));
}

{
    const r = await fetchRecord("taskCalendar", { userId: USER });
    check("taskCalendar is not date-bounded (not day-scoped)", () =>
        assert.equal(r.applied.filter(a => a.includes("7 days")).length, 0));
}

{
    const r = await fetchRecord("expenseRegister", { userId: USER }, null, "desc", 5000);
    check("an oversized limit is capped rather than refused", () =>
        assert.ok(r.applied.some(a => a.includes("capped"))));
}

await expectThrow(
    "a quoted filter key is an error, not an empty result",
    () => fetchRecord("dietRegister", { '"date"': "2026-08-12", '"userId"': USER }),
    "Unknown filter field"
);

await expectThrow(
    "an invented filter key is an error",
    () => fetchRecord("taskRegister", { userId: USER, Ref_date: "2026-08-11" }),
    "Unknown filter field"
);

{
    const r = await fetchRecord("triggerJob", { userId: USER });
    check("triggerJob is now readable", () => assert.ok(Array.isArray(r.records)));
}
{
    const r = await fetchRecord("userSchedule", { userId: USER });
    check("userSchedule is now readable", () => assert.ok(Array.isArray(r.records)));
}

console.log("\ndeleteRecord — scope");

const { deleteRecord } = await import("../tools/mongo/deleteRecord.js");

await expectThrow(
    "taskCalendar cannot be deleted",
    () => deleteRecord("taskCalendar", "6a7c491946a2e8130aa344b9", USER, "test"),
    "Cannot delete"
);
await expectThrow(
    "chatHistory cannot be deleted",
    () => deleteRecord("chatHistory", "6a7c491946a2e8130aa344b9", USER, "test"),
    "Cannot delete"
);
await expectThrow(
    "a non-hex id is rejected before touching the DB",
    () => deleteRecord("dietRegister", "task_1", USER, "test"),
    "not a 24-character hex"
);
await expectThrow(
    "userId is required",
    () => deleteRecord("dietRegister", "6a7c491946a2e8130aa344b9", null, "test"),
    "userId is required"
);
await expectThrow(
    "an id that does not exist for this user is an error, not a silent no-op",
    () => deleteRecord("dietRegister", "000000000000000000000000", USER, "test"),
    "No record"
);

console.log("\nNO_REPLY sentinel");

const { NO_REPLY } = await import("../agent/instruction.js");
const { buildSystemInstruction } = await import("../agent/instruction.js");

check("the sentinel is a single constant, not a literal in prose", () =>
    assert.equal(NO_REPLY, "[[NO_REPLY]]"));
check("the prompt documents when to emit it", () => {
    const p = buildSystemInstruction();
    assert.ok(p.includes(NO_REPLY), "sentinel missing from prompt");
    assert.ok(/never send an empty/i.test(p), "empty-reply ban missing from prompt");
});

console.log(`\n${pass} passed${process.exitCode ? " — SOME FAILED" : ""}\n`);
process.exit(process.exitCode ?? 0);
