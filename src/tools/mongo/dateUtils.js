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
