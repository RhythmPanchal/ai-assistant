/**
 * Hand-run:  node src/test/testDayWindow.js
 *
 * The personal day: where one day's conversation ends, and the block that says
 * so when the replayed history is not today's. Pure — no database, no key.
 *
 * The case every assertion here exists for was observed in prod. On 2026-09-19
 * at 00:42 the agent was mid-wrap-up for the 18th. The history window was the
 * calendar day, so it was handed two turns instead of eight: the 23:30 opener
 * it had written 70 minutes earlier was on the other side of midnight. It
 * re-logged the whole of the 18th under the 19th, and the next night's opener
 * read those rows back as "I've already logged your lunch and dinner".
 */
import assert from "node:assert";

const { personalDayRange, localHourOf, localDayRange, DAY_START_HOUR, IST_TIMEZONE } =
    await import("../tools/mongo/dateUtils.js");
const { buildSystemInstruction } = await import("../agent/instruction.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const IST = IST_TIMEZONE;
// Wall-clock IST as an instant, so every case below reads as the clock the
// person was looking at rather than as a UTC offset done in the head.
const ist = (s) => new Date(`${s}+05:30`);
const istLabel = (d) => d.toLocaleString("sv-SE", { timeZone: IST }).replace(" ", "T");

// ------------------------------------------------------ the boundary itself --
test("the default boundary is 04:00", () => {
    assert.strictEqual(DAY_START_HOUR, 4);
});

test("00:42 belongs to the day before — the prod case", () => {
    const { start, end } = personalDayRange(ist("2026-09-19T00:42:51"), { timeZone: IST });
    assert.strictEqual(istLabel(start), "2026-09-18T04:00:00");
    assert.strictEqual(istLabel(end), "2026-09-19T04:00:00");
});

test("the boundary hour itself opens the new day, the minute before does not", () => {
    assert.strictEqual(istLabel(personalDayRange(ist("2026-09-19T04:00:00"), { timeZone: IST }).start), "2026-09-19T04:00:00");
    assert.strictEqual(istLabel(personalDayRange(ist("2026-09-19T03:59:59"), { timeZone: IST }).start), "2026-09-18T04:00:00");
});

test("an ordinary afternoon is its own calendar day", () => {
    const { start, end } = personalDayRange(ist("2026-09-19T15:20:00"), { timeZone: IST });
    assert.strictEqual(istLabel(start), "2026-09-19T04:00:00");
    assert.strictEqual(istLabel(end), "2026-09-20T04:00:00");
});

test("the range is half-open and contiguous — no instant in two days, none in neither", () => {
    const at = ist("2026-09-19T00:42:51");
    const { end } = personalDayRange(at, { timeZone: IST });
    // The instant the day ends is the instant the next one starts.
    assert.strictEqual(personalDayRange(end, { timeZone: IST }).start.getTime(), end.getTime());
    // And the last millisecond before it still belongs to the old day.
    assert.strictEqual(
        personalDayRange(new Date(end.getTime() - 1), { timeZone: IST }).start.getTime(),
        personalDayRange(at, { timeZone: IST }).start.getTime()
    );
});

test("hour 0 reproduces localDayRange exactly", () => {
    for (const at of ["2026-09-19T00:42:51", "2026-09-19T15:20:00", "2026-09-19T23:59:59"]) {
        const mine = personalDayRange(ist(at), { hour: 0, timeZone: IST });
        const theirs = localDayRange(at.slice(0, 10));
        assert.strictEqual(mine.start.getTime(), theirs.start.getTime(), at);
        assert.strictEqual(mine.end.getTime(), theirs.end.getTime(), at);
    }
});

test("an explicit dayStartHour is honoured over the default", () => {
    // Someone who starts at 05:00 for a shift: 04:30 is now a NEW day, where
    // with the default it would still be the old one.
    const at = ist("2026-09-19T04:30:00");
    assert.strictEqual(istLabel(personalDayRange(at, { hour: 3, timeZone: IST }).start), "2026-09-19T03:00:00");
    assert.strictEqual(istLabel(personalDayRange(at, { hour: 9, timeZone: IST }).start), "2026-09-18T09:00:00");
});

test("the offset is resolved per instant, not assumed — a dst zone", () => {
    const NY = "America/New_York";
    const span = (iso) => {
        const r = personalDayRange(new Date(iso), { timeZone: NY });
        // Whatever the clocks did, both ends are 04:00 in the zone's own time —
        // which is the property that breaks if the offset is read once and reused.
        assert.strictEqual(localHourOf(r.start, NY), 4, `start of ${iso}`);
        assert.strictEqual(localHourOf(r.end, NY), 4, `end of ${iso}`);
        return (r.end - r.start) / 3600000;
    };
    // A personal day is 24 hours long only when the clocks do not move inside
    // it. 2026-03-08 02:00 is the US spring-forward and 2026-11-01 02:00 the
    // fall-back, and each lands inside the 04:00-to-04:00 day that starts the
    // afternoon before. A fixed +24h would report 24 for all three.
    assert.strictEqual(span("2026-06-15T12:00:00-04:00"), 24, "an ordinary day");
    assert.strictEqual(span("2026-03-07T12:00:00-05:00"), 23, "the day the clocks go forward");
    assert.strictEqual(span("2026-10-31T12:00:00-04:00"), 25, "the day the clocks go back");
});

test("localHourOf reads the hour in the given zone, h23", () => {
    assert.strictEqual(localHourOf(ist("2026-09-19T00:42:51"), IST), 0);
    assert.strictEqual(localHourOf(ist("2026-09-19T23:30:00"), IST), 23);
    assert.strictEqual(localHourOf(ist("2026-09-19T12:00:00"), IST), 12);
    // Same instant, another zone: 00:42 IST is 19:12 the previous day in UTC.
    assert.strictEqual(localHourOf(ist("2026-09-19T00:42:51"), "UTC"), 19);
});

// -------------------------------------------------- saying the history is old --
test("no carriedFrom → no block at all", () => {
    const out = buildSystemInstruction([], { carriedFrom: null });
    assert.ok(!/IS OLD/.test(out), "a normal turn must not carry the stale-history block");
});

test("carriedFrom → a block naming the day, placed last", () => {
    const out = buildSystemInstruction([], { carriedFrom: "2026-09-18" });
    assert.match(out, /THE CONVERSATION BELOW IS OLD — from 2026-09-18, not today/);
    // Last, because it describes the messages replayed after the instruction.
    // Anything appended below it would sit between the warning and what it warns about.
    assert.ok(out.trimEnd().endsWith("Today starts with the message at the very end."),
        "the block must be the final thing before the replayed history");
});

test("the block forbids the four things that go wrong", () => {
    const out = buildSystemInstruction([], { carriedFrom: "2026-09-16 to 2026-09-18" });
    assert.match(out, /2026-09-16 to 2026-09-18/);
    assert.match(out, /Do not answer anything asked in it/);
    assert.match(out, /do not treat what it describes as happening now/);
    assert.match(out, /Do not judge today by it/);
    assert.match(out, /say when it was/);
});

test("a routine overlay still lands after it, and neither is lost", () => {
    const out = buildSystemInstruction(["OVERLAY BODY"], { carriedFrom: "2026-09-18" });
    assert.match(out, /IS OLD/);
    assert.match(out, /OVERLAY BODY/);
});

let pass = 0;
for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log(`PASS  ${name}`); }
    catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
