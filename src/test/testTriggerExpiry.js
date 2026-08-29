/**
 * Hand-run:  node src/test/testTriggerExpiry.js
 *
 * Covers expiryDate enforcement and the timeZone that getNextCronDate used to
 * ignore. Needs .env for MONGO_DB_URI (mongoClient builds its client at import)
 * but never connects, so nothing here touches the database.
 *
 * The failure being pinned: expiryDate was written from the beginning and read
 * by nothing, so "remind me for a month" ran forever. Call Masi expired on
 * 2026-07-25 and was still firing on 2026-08-27.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const tests = [];
const test = (n, f) => tests.push([n, f]);

const IST = "Asia/Kolkata";
const past = new Date("2026-07-25T00:00:00+05:30");
const future = new Date("2099-01-01T00:00:00+05:30");

test("a job past its expiry is retired, not rescheduled", async () => {
    const { scheduleNextRun } = await import("../scheduler/executeTriggerJob.js");

    // The real Call Masi row: Thursdays at 21:30 IST, expired five weeks before
    // anyone noticed it was still arriving.
    const out = scheduleNextRun({ cronPattern: "30 21 * * 4", timeZone: IST, expiryDate: past });

    assert.strictEqual(out.status, "completed");
    assert.strictEqual(out.nextExecutionAt, null, "a retired job must not keep a fire time");
});

test("a job inside its expiry keeps running", async () => {
    const { scheduleNextRun } = await import("../scheduler/executeTriggerJob.js");
    const out = scheduleNextRun({ cronPattern: "0 21 * * *", timeZone: IST, expiryDate: future });

    assert.strictEqual(out.status, "active");
    assert.ok(out.nextExecutionAt instanceof Date);
    assert.ok(out.nextExecutionAt <= future);
});

test("no expiry means run indefinitely", async () => {
    const { scheduleNextRun } = await import("../scheduler/executeTriggerJob.js");

    for (const expiryDate of [null, undefined]) {
        const out = scheduleNextRun({ cronPattern: "0 21 * * *", timeZone: IST, expiryDate });
        assert.strictEqual(out.status, "active", `expiryDate ${expiryDate} must not retire the job`);
        assert.ok(out.nextExecutionAt instanceof Date);
    }
});

test("the job's own timeZone decides when its cron fires", async () => {
    const { getNextCronDate } = await import("../scheduler/executeTriggerJob.js");

    // 09:00 in three zones cannot be the same instant. This failed to be true
    // while the parser was hardcoded to Asia/Kolkata and ignored its argument.
    const ist = getNextCronDate("0 9 * * *", IST);
    const syd = getNextCronDate("0 9 * * *", "Australia/Sydney");
    const nyc = getNextCronDate("0 9 * * *", "America/New_York");

    assert.notStrictEqual(ist.getTime(), syd.getTime(), "Sydney 9am is not IST 9am");
    assert.notStrictEqual(ist.getTime(), nyc.getTime(), "New York 9am is not IST 9am");
});

test("a missing timeZone still falls back to IST", async () => {
    const { getNextCronDate } = await import("../scheduler/executeTriggerJob.js");

    // Every existing row is Asia/Kolkata, so the fallback is what keeps this
    // change from moving any reminder already in the database.
    const explicit = getNextCronDate("0 9 * * *", IST);
    for (const tz of [undefined, null, ""]) {
        assert.strictEqual(getNextCronDate("0 9 * * *", tz).getTime(), explicit.getTime());
    }
});

test("no cron pattern means no next run", async () => {
    const { getNextCronDate } = await import("../scheduler/executeTriggerJob.js");
    assert.strictEqual(getNextCronDate(null, IST), null);
    assert.strictEqual(getNextCronDate(undefined, IST), null);
});

test("a broken cron names both the pattern and the zone", async () => {
    const { getNextCronDate } = await import("../scheduler/executeTriggerJob.js");
    assert.throws(() => getNextCronDate("not a cron", IST), /not a cron/);
    assert.throws(() => getNextCronDate("0 9 * * *", "Mars/Olympus"), /Mars\/Olympus/);
});

test("the due query keeps its null and $exists branches", () => {
    // The one mistake here that would be invisible in testing and catastrophic
    // in production. Mongo type-brackets range operators, so { $gt: <Date> }
    // matches neither null nor a missing field. Dropping either branch would
    // silently stop every reminder that has no expiry — which is most of them.
    const src = readFileSync(new URL("../scheduler/initCron.js", import.meta.url), "utf8");

    assert.ok(/\{ expiryDate: null \}/.test(src), "null expiry must still be due");
    assert.ok(/\{ expiryDate: \{ \$exists: false \} \}/.test(src), "missing expiry must still be due");
    assert.ok(/\{ expiryDate: \{ \$gt: now \} \}/.test(src), "unexpired jobs must still be due");
});

test("the sweep never retires a job that has no expiry", () => {
    const src = readFileSync(new URL("../scheduler/initCron.js", import.meta.url), "utf8");

    // The mirror image of the branch above, on the write side.
    assert.ok(
        /expiryDate: \{ \$ne: null, \$lte: now \}/.test(src),
        "the sweep must exclude null expiry explicitly"
    );
    assert.ok(/status: "completed"/.test(src), "an expired job is completed, not cancelled");
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
