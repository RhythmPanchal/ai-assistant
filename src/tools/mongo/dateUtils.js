/**
 * Force an LLM-emitted datetime string into Asia/Kolkata wall-clock time.
 *
 * The LLM is instructed to emit naive ISO local time, but historically it has
 * appended `Z` (treating local 9 PM as 9 PM UTC = 2:30 AM IST) or, less often,
 * a wrong offset. Stripping any trailing TZ marker and re-anchoring to +05:30:
 *  - rescues sloppy LLM output, and
 *  - is a no-op on already-correct naive strings.
 *
 * Date instances and null/undefined pass through unchanged.
 */
export function toIST(s) {
  if (s instanceof Date) return s;
  if (s == null) return s;
  let str = String(s).replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
  if (!str.includes("T")) str += "T00:00:00";
  return new Date(str + "+05:30");
}

export const IST_TIMEZONE = "Asia/Kolkata";

/**
 * The calendar date, in `timeZone`, that an instant falls on — "YYYY-MM-DD".
 *
 * A day label is not an instant. Which day a wrap-up belongs to is decided
 * ONCE, when the routine opens, and must never be re-derived from the clock
 * afterwards: a wrap-up typed at 02:47 still belongs to the day that ended.
 * Letting the model resolve "today" against the live clock produced logs on
 * the wrong day roughly half the time, and once on 2019-12-31.
 *
 * Emit this bare string to the model. A date-only string is also the one form
 * `toIST` round-trips identically, so it cannot be shifted by a later parse.
 */
export function localDateOf(instant, timeZone = IST_TIMEZONE) {
  // Checked before constructing: new Date(null) is epoch 0, not Invalid Date,
  // so a missing startedAt would otherwise label the flow "1970-01-01".
  if (instant == null) return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone });
}

/**
 * The half-open instant range [start, end) covering one local calendar day.
 *
 * Half-open rather than 00:00:00-23:59:59.999 because the closed form has a
 * millisecond hole at the top of every day, and a turn that lands in it belongs
 * to neither day.
 *
 * Anchored through toIST like every other date here, so it inherits the same
 * hardcoded zone — see the note in CLAUDE.md. It is the right single place to
 * fix when the zone stops being global.
 *
 * @param {string} date "YYYY-MM-DD"
 */
export function localDayRange(date) {
  const start = toIST(`${date}T00:00:00`);
  return { start, end: new Date(start.getTime() + 86400000) };
}

/**
 * The calendar day before `date`, as "YYYY-MM-DD".
 *
 * Anchored at midday UTC before subtracting, so the arithmetic cannot land on
 * the wrong side of a day boundary in any zone — the failure a naive
 * midnight-minus-24h has twice a year wherever DST applies.
 *
 * @param {string} date "YYYY-MM-DD"
 */
export function previousDay(date) {
  if (!date) return null;
  const at = new Date(`${date}T12:00:00Z`);
  if (isNaN(at.getTime())) return null;
  return new Date(at.getTime() - 86400000).toISOString().slice(0, 10);
}

/**
 * An instant as wall-clock time in `timeZone`: "YYYY-MM-DDTHH:mm:ss", naive.
 *
 * Naive on purpose — it is the exact form HARD RULE 4 tells the model to WRITE,
 * so what it reads back and what it sends round-trip through toIST unchanged.
 */
export function localDateTimeOf(instant, timeZone = IST_TIMEZONE) {
  if (instant == null) return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(d.getTime())) return null;
  const part = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}`;
}

/**
 * A copy of `value` with every Date rewritten as the user's local time — for
 * anything a model is about to read.
 *
 * Left alone, a Date serialises as UTC, and every day-scoped row here is stored
 * at IST midnight: 2026-09-17 becomes "2026-09-16T18:30:00.000Z", which reads as
 * the day before. Every row a tool returned was shown to the model a day early.
 * In the night eval a model fetched a correctly dated expense, read it as
 * yesterday, and spent twenty steps deleting and re-creating it.
 *
 *  - a `date` field at local midnight  → "2026-09-17"
 *  - any other Date                    → "2026-09-18T21:00:00"
 *
 * Only `date` collapses to a bare day: a reminder due at midnight must keep its
 * time, and a `date` that is NOT at midnight — a row stamped before the date
 * handling was fixed — shows its real time rather than being tidied into a
 * plausible day.
 *
 * ObjectIds become their hex string and class instances (a ToolResult) become
 * plain objects, which is what they serialised to anyway.
 */
export function datesForModel(value, { timeZone = IST_TIMEZONE, key = null, depth = 0 } = {}) {
  if (depth > 20) return value;
  if (value instanceof Date) {
    const local = localDateTimeOf(value, timeZone);
    if (!local) return null;
    return key === "date" && local.endsWith("T00:00:00") ? local.slice(0, 10) : local;
  }
  if (Array.isArray(value)) {
    return value.map((v) => datesForModel(v, { timeZone, key, depth: depth + 1 }));
  }
  if (value && typeof value === "object") {
    if (value._bsontype) return typeof value.toJSON === "function" ? value.toJSON() : String(value);
    if (ArrayBuffer.isView(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, datesForModel(v, { timeZone, key: k, depth: depth + 1 })])
    );
  }
  return value;
}

/** That zone's UTC offset at that instant, as "+05:30". Honours DST. */
function zoneOffset(timeZone, at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return name?.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? "+00:00";
}

/**
 * A Date at `hour`:00 wall-clock in `timeZone`, `dayOffset` days from `from`.
 *
 * Flow cutoffs are stated in the user's own day ("close it at 6pm, the day is
 * over"), so they cannot be computed as a fixed number of hours from now.
 *
 * `from` defaults to now, which is every caller but personalDayRange — that one
 * needs the boundaries around an arbitrary instant, not around the clock.
 */
export function atLocalHour(hour, timeZone = IST_TIMEZONE, dayOffset = 0, from = Date.now()) {
  const base = from instanceof Date ? from.getTime() : from;
  const at = new Date(base + dayOffset * 86400000);
  const ymd = at.toLocaleDateString("en-CA", { timeZone });
  return new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00${zoneOffset(timeZone, at)}`);
}

/**
 * The local hour, 0-23, that an instant falls on in `timeZone`. Via
 * formatToParts because format() gives "04", "4" or "4 AM" by locale.
 */
export function localHourOf(instant, timeZone = IST_TIMEZONE) {
  const at = instant instanceof Date ? instant : new Date(instant);
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(at)
    .find((p) => p.type === "hour")?.value;
  return Number(part);
}

/**
 * The hour a person's day rolls over, when they have not said.
 *
 * Not midnight, which cuts a wrap-up answered at 00:42 away from the opener it
 * is answering. Not the hour they wake either: the boundary has to fall where
 * nobody is talking, or an early start carries yesterday into a new day.
 * Per-user via preferences.dayStartHour.
 */
export const DAY_START_HOUR = 4;

/**
 * The half-open instant range [start, end) of the personal day `at` falls in —
 * one `hour`:00 to the next, so a stretch of being awake is one day however
 * late it runs. `hour = 0` reproduces localDayRange exactly.
 */
export function personalDayRange(at = new Date(), { hour = DAY_START_HOUR, timeZone = IST_TIMEZONE } = {}) {
  const from = at instanceof Date ? at : new Date(at);
  const dayOffset = localHourOf(from, timeZone) >= hour ? 0 : -1;
  return {
    start: atLocalHour(hour, timeZone, dayOffset, from),
    end: atLocalHour(hour, timeZone, dayOffset + 1, from),
  };
}
