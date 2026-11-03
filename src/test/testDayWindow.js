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

const { personalDayRange, personalDayRangeOf, personalDayOf, localHourOf, localDayRange, dayScope, DAY_START_HOUR, IST_TIMEZONE } =
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

/*
 * Reading a day BACK. The console lists days and then asks for one by label,
 * so the label -> range mapping has to be the exact inverse of the range ->
 * label one. Get it wrong and a day opens showing the neighbouring day's
 * conversation, which reads as data loss rather than as an off-by-one.
 */

test("a day label maps back to the range it labels", () => {
    const range = personalDayRangeOf("2026-09-19", { hour: 6, timeZone: IST });
    assert.equal(range.start.toISOString(), ist("2026-09-19T06:00").toISOString());
    assert.equal(range.end.toISOString(), ist("2026-09-20T06:00").toISOString());
});

test("the label of a range is the day it STARTS on", () => {
    // 02:00 on the 20th, for someone whose day starts at 06:00, is still the
    // 19th — the night they are still awake in.
    assert.equal(personalDayOf(ist("2026-09-20T02:00"), { hour: 6, timeZone: IST }), "2026-09-19");
    assert.equal(personalDayOf(ist("2026-09-20T06:00"), { hour: 6, timeZone: IST }), "2026-09-20");
    assert.equal(personalDayOf(ist("2026-09-19T23:59"), { hour: 6, timeZone: IST }), "2026-09-19");
});

test("label and range are inverses at every hour of a day", () => {
    for (const hour of [0, 4, 6, 9, 23]) {
        for (const at of [ist("2026-09-19T00:30"), ist("2026-09-19T12:00"), ist("2026-09-19T23:30")]) {
            const label = personalDayOf(at, { hour, timeZone: IST });
            const range = personalDayRangeOf(label, { hour, timeZone: IST });
            assert.ok(
                at >= range.start && at < range.end,
                `hour ${hour}: ${at.toISOString()} not inside the range of its own label ${label}`,
            );
        }
    }
});

test("hour 0 is the calendar day", () => {
    const range = personalDayRangeOf("2026-09-19", { hour: 0, timeZone: IST });
    const calendar = localDayRange("2026-09-19");
    assert.equal(range.start.toISOString(), calendar.start.toISOString());
    assert.equal(range.end.toISOString(), calendar.end.toISOString());
});

test("a day is 24 hours long in a zone without DST", () => {
    const range = personalDayRangeOf("2026-09-19", { hour: 6, timeZone: IST });
    assert.equal(range.end - range.start, 86400000);
});

test("a garbage label is refused rather than guessed at", () => {
    assert.equal(personalDayRangeOf("not-a-date", { hour: 6, timeZone: IST }), null);
});

// ------------------------------------------------------ reading the scope off a user --
test("dayScope reads both fields, and falls back to the defaults", () => {
    assert.deepEqual(dayScope({ timezone: "Europe/London", preferences: { dayStartHour: 9 } }),
        { timeZone: "Europe/London", dayStartHour: 9 });
    assert.deepEqual(dayScope(null), { timeZone: IST, dayStartHour: DAY_START_HOUR });
    assert.deepEqual(dayScope({}), { timeZone: IST, dayStartHour: DAY_START_HOUR });
});

test("dayScope ignores a dayStartHour that is not a whole hour", () => {
    // A non-integer reaching atLocalHour builds an unparseable datetime and the
    // day silently becomes Invalid Date, so it has to be refused here.
    assert.equal(dayScope({ preferences: { dayStartHour: "9" } }).dayStartHour, DAY_START_HOUR);
    assert.equal(dayScope({ preferences: { dayStartHour: 9.5 } }).dayStartHour, DAY_START_HOUR);
    assert.equal(dayScope({ preferences: { dayStartHour: null } }).dayStartHour, DAY_START_HOUR);
});

test("dayStartHour 0 is honoured, not treated as absent", () => {
    // The one value a truthiness check would drop, and it means something:
    // a person whose day really is midnight to midnight.
    assert.equal(dayScope({ preferences: { dayStartHour: 0 } }).dayStartHour, 0);
});

/*
 * What the model is TOLD the date is. The window above was only ever half of
 * it: the agent read the right conversation and then labelled everything in it
 * with the calendar date, because RIGHT NOW was built from the clock. At 00:30
 * that is the date that has just begun, and the prompt told the model in as many
 * words to resolve "today" against it.
 */
const nowBlockAt = (now, opts = {}) => buildSystemInstruction([], { order: ["now"], now, ...opts });

test("before the rollover the prompt gives their day, not the calendar's", () => {
    const out = nowBlockAt(ist("2026-02-12T00:30:00"));
    assert.match(out, /Their day: 2026-02-11/);
    assert.ok(!/Their day: 2026-02-12/.test(out), "the calendar date must not be offered as their day");
});

test("the weekday is the personal day's, not the instant's", () => {
    // 2026-02-12 is a Thursday; the day it belongs to is Wednesday the 11th.
    // Getting this from the instant makes the block contradict itself, which is
    // an invitation to the model to pick the half it likes.
    assert.match(nowBlockAt(ist("2026-02-12T00:30:00")), /Their day: 2026-02-11 \(Wednesday\)/);
});

test("the real clock is still shown, so a reminder is not dated a day back", () => {
    // The failure this prevents: "today is the 11th" plus "remind me in ten
    // minutes" dates the reminder 2026-02-11T00:40 — 24 hours in the past,
    // where it fires instantly or never.
    const out = nowBlockAt(ist("2026-02-12T00:30:00"));
    assert.match(out, /Clock:\s+2026-02-12 00:30:00/);
    assert.match(out, /Scheduling something still to COME is a real instant/);
    assert.match(out, /Filing something that HAPPENED/);
});

test("an explicit dayStartHour moves the prompt's boundary with it", () => {
    // 06:00 is a new calendar day and a new default day, but not a new day for
    // someone who starts at 09:00.
    assert.match(nowBlockAt(ist("2026-02-12T06:00:00"), { dayStartHour: 9 }), /Their day: 2026-02-11/);
    assert.match(nowBlockAt(ist("2026-02-12T06:00:00")), /Their day: 2026-02-12/);
    assert.match(nowBlockAt(ist("2026-02-12T06:00:00"), { dayStartHour: 9 }), /runs 09:00 to 09:00/);
});

test("after the rollover the extra paragraph is gone", () => {
    // It costs prompt on every ordinary turn, and the model has to read past it
    // to reach the rules. It is only true for four hours a day.
    const out = nowBlockAt(ist("2026-02-11T15:30:00"));
    assert.match(out, /Their day: 2026-02-11 \(Wednesday\)/);
    assert.ok(!/past midnight/i.test(out), "the midnight paragraph must not show at 15:30");
    assert.match(out, /Resolve "today", "tomorrow", "tonight", "next week" against their day/);
});

test("the zone comes from the caller, not from a constant in the prompt", () => {
    // 2026-02-12T00:30 IST is still 2026-02-11 19:00 in London, so a London
    // user is mid-evening on the 11th — same label, different reason, and the
    // block must name the zone it used.
    const out = nowBlockAt(ist("2026-02-12T00:30:00"), { timeZone: "Europe/London" });
    assert.match(out, /Their day: 2026-02-11/);
    assert.match(out, /Europe\/London/);
    assert.ok(!/Asia\/Kolkata/.test(out), "the user's zone must not be overridden by the default");
});

let pass = 0;
for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log(`PASS  ${name}`); }
    catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
