/**
 * Measures what a conversation turn ACTUALLY costs in LLM API calls.
 *
 * The agent loop issues one API request per ReAct step, not one per user
 * message. A single "logged dinner + ₹200 auto + 3 tasks" turn can be 3-8
 * requests (initial -> tool results -> more tools -> final text). That
 * multiplier is invisible from the Telegram side, which is why a 250 RPD
 * quota feels like "20 messages a day".
 *
 * Nothing here changes agent behaviour — it only counts.
 */

export const LLM_USAGE = "llmUsage";

// Google's quota errors distinguish per-minute from per-day limits only inside
// the QuotaFailure violations (quotaId like "GenerateRequestsPerDayPerProject
// PerModel-FreeTier"). Hitting RPM and hitting RPD both surface as a bare 429,
// so without this split you cannot tell "slow down" from "come back tomorrow".
export function classifyQuotaError(err) {
  const blob = JSON.stringify(
    err?.response?.data ?? err?.error ?? { m: err?.message ?? String(err) }
  );

  const is429 = /\b429\b|RESOURCE_EXHAUSTED|too many requests/i.test(blob);
  if (!is429) return { kind: "OTHER", is429: false, retryAfterSec: null };

  const retryMatch = blob.match(/retryDelay"?[:\s"]+(\d+(?:\.\d+)?)s/i);
  const retryAfterSec = retryMatch ? Number(retryMatch[1]) : null;

  if (/PerDay|per day|daily limit|RequestsPerDay/i.test(blob)) {
    return { kind: "RPD", is429: true, retryAfterSec };
  }
  if (/PerMinute|per minute|RequestsPerMinute/i.test(blob)) {
    return { kind: "RPM", is429: true, retryAfterSec };
  }
  // A 429 we cannot attribute. A short retryDelay implies a per-minute window;
  // a multi-hour one implies the daily bucket is gone.
  if (retryAfterSec != null) {
    return { kind: retryAfterSec <= 120 ? "RPM" : "RPD", is429: true, retryAfterSec };
  }
  return { kind: "UNKNOWN_429", is429: true, retryAfterSec };
}

// Gemini free-tier daily quota resets at midnight PACIFIC, not IST. Bucketing
// by IST would smear each reset across two rows and make the daily ceiling
// unreadable, so we record both and key the counters on the Pacific day.
function dayKeys() {
  const now = new Date();
  return {
    istDate: now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    ptDate: now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
  };
}

/**
 * Opens a measurement scope for one runAgent turn.
 * @param {number} userId
 * @param {string} source  "telegram" | "goodMorningJob" | "goodNightJob" | ...
 * @param {string} model
 */
// Mongo reads dots in an $inc path as nested fields, and every model id has
// them ("gemini-3.5-flash-lite" would become byModel.gemini-3 → 5-flash-lite).
const safeKey = (s) => String(s).replace(/\./g, "_");

export function startTurn(userId, source = "telegram") {
  const startedAt = Date.now();
  let calls = 0;
  const errors = [];
  const byModel = {};

  return {
    /**
     * One outbound request, labelled "provider:model". Called per ATTEMPT, not
     * per agent step — a step that falls gemini -> groq is two real requests,
     * and each model has its own daily bucket, so per-model is the granularity
     * that actually predicts exhaustion.
     */
    recordCall(label = "unknown") {
      calls += 1;
      byModel[label] = (byModel[label] || 0) + 1;
      return calls;
    },

    recordError(err) {
      const c = classifyQuotaError(err);
      errors.push(c);
      if (c.is429) {
        console.warn(
          `[usage] 429 on call #${calls} — limit=${c.kind}` +
            (c.retryAfterSec != null ? ` retryAfter=${c.retryAfterSec}s` : "") +
            (c.kind === "RPD"
              ? "  <- daily bucket exhausted, more providers will not help until reset"
              : c.kind === "RPM"
              ? "  <- per-minute burst, spacing the loop would fix this"
              : "")
        );
      }
      return c;
    },

    /**
     * Logs the turn and folds it into today's rolling totals.
     * Never throws — a metering failure must not break a reply.
     */
    async finish(outcome = "ok") {
      const durationMs = Date.now() - startedAt;
      const { istDate, ptDate } = dayKeys();

      const mix = Object.entries(byModel).map(([m, c]) => `${m}×${c}`).join(" ") || "none";
      console.log(
        `[usage] turn done: calls=${calls} [${mix}] source=${source} ` +
          `outcome=${outcome} ${durationMs}ms`
      );

      try {
        // Imported lazily: mongoClient.js builds its MongoClient at module
        // scope, so a static import would make this file unloadable (and the
        // classifier untestable) without MONGO_DB_URI already in the env.
        const { getDB } = await import("../../tools/mongo/mongoClient.js");
        const db = await getDB();
        const res = await db.collection(LLM_USAGE).findOneAndUpdate(
          { userId, ptDate },
          {
            $inc: {
              turns: 1,
              calls,
              [`bySource.${safeKey(source)}`]: calls,
              ...Object.fromEntries(
                Object.entries(byModel).map(([m, c]) => [`byModel.${safeKey(m)}`, c])
              ),
              [`errors.${errors.length ? errors[errors.length - 1].kind : "none"}`]:
                errors.length ? 1 : 0,
            },
            $max: { maxCallsInATurn: calls },
            $set: { istDate, updatedAt: new Date() },
            $setOnInsert: { userId, ptDate, createdAt: new Date() },
          },
          { upsert: true, returnDocument: "after" }
        );

        const doc = res?.value ?? res;
        if (doc?.calls && doc?.turns) {
          console.log(
            `[usage] today (PT ${ptDate}): ${doc.calls} calls over ${doc.turns} turns ` +
              `= ${(doc.calls / doc.turns).toFixed(1)} calls/turn, ` +
              `worst turn ${doc.maxCallsInATurn}`
          );
        }
      } catch (e) {
        console.error("[usage] failed to persist (ignored):", e.message);
      }

      return { calls, durationMs, errors };
    },
  };
}
