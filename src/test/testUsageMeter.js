/**
 * Hand-run:  node src/test/testUsageMeter.js
 *
 * Covers classifyQuotaError only — the one piece of usageMeter with real
 * branching. Getting RPM vs RPD wrong is expensive: an RPM block means
 * "space the loop out", an RPD block means "the day is over, no amount of
 * retrying or provider-switching on the same key helps". Both arrive as a
 * bare 429, so this mapping is what makes the logs actionable.
 *
 * No DB or network needed.
 */
import { classifyQuotaError } from "../agent/llm/usageMeter.js";

const quotaFailure = (quotaId, retryDelay) => ({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
    ],
  },
});

const cases = [
  ["RPD (daily bucket gone)", quotaFailure("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "3600s"), "RPD"],
  ["RPM (per-minute burst)", quotaFailure("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "21s"), "RPM"],
  ["bare 429, short delay -> infer RPM", { message: "429 Too Many Requests retryDelay: 15s" }, "RPM"],
  ["bare 429, long delay -> infer RPD", { message: "429 Too Many Requests retryDelay: 7200s" }, "RPD"],
  ["bare 429, no signal", { message: "429 Too Many Requests" }, "UNKNOWN_429"],
  ["not a quota error", { message: "ECONNRESET socket hang up" }, "OTHER"],
];

let pass = 0;
for (const [name, err, want] of cases) {
  const got = classifyQuotaError(err);
  const ok = got.kind === want;
  if (ok) pass++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} -> ${got.kind}` +
      `${got.retryAfterSec != null ? ` (retry ${got.retryAfterSec}s)` : ""}` +
      `${ok ? "" : `  EXPECTED ${want}`}`
  );
}

console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
