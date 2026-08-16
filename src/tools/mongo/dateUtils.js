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

/** That zone's UTC offset at that instant, as "+05:30". Honours DST. */
function zoneOffset(timeZone, at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return name?.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? "+00:00";
}

/**
 * A Date at `hour`:00 wall-clock in `timeZone`, `dayOffset` days from now.
 *
 * Flow cutoffs are stated in the user's own day ("close it at 6pm, the day is
 * over"), so they cannot be computed as a fixed number of hours from now.
 */
export function atLocalHour(hour, timeZone = IST_TIMEZONE, dayOffset = 0) {
  const at = new Date(Date.now() + dayOffset * 86400000);
  const ymd = at.toLocaleDateString("en-CA", { timeZone });
  return new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00${zoneOffset(timeZone, at)}`);
}
