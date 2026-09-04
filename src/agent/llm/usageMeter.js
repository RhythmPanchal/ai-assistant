/**
 * Measures what a conversation turn ACTUALLY costs in LLM API calls.
 *
 * The agent loop issues one API request per ReAct step, not one per user
 * message. A single "logged dinner + ₹200 auto + 3 tasks" turn can be 3-8
 * requests (initial -> tool results -> more tools -> final text). That
 * multiplier is invisible from the Telegram side, which is why a daily
 * request quota feels far smaller than its headline number.
 *
 * Nothing here changes agent behaviour — it only counts.
 */

import { estimateCost } from "../../config/pricing.js";

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
// version numbers in them, so "byModel.<id>" would split at the dot.
const safeKey = (s) => String(s).replace(/\./g, "_");

export function startTurn(userId, source = "telegram", task = null) {
  const startedAt = Date.now();
  let calls = 0;
  let steps = 0;
  let llmMs = 0;
  const errors = [];
  const byModel = {};
  const attempts = [];

  /**
   * The turn's numbers. Pure — no I/O, so it is safe to call before the
   * chatHistory write. That is what lets one set of figures reach the document,
   * the caller and the daily rollup without being computed three times.
   */
  function summary(outcome = "ok") {
    const durationMs = Date.now() - startedAt;

    const tok = attempts.reduce((a, x) => ({
      input: a.input + x.input,
      output: a.output + x.output,
      reasoning: a.reasoning + x.reasoning,
      cached: a.cached + x.cached,
    }), { input: 0, output: 0, reasoning: 0, cached: 0 });

    const served = attempts.filter((a) => a.ok);
    const withPrice = served.filter((a) => a.listUsd !== null);
    // priced:false alongside a non-null total means a lower bound — some model
    // in the turn had no entry in the price table.
    const priced = served.length > 0 && withPrice.length === served.length;

    return {
      task, source, outcome,
      steps, calls,
      durationMs,
      llmMs,
      // Everything not spent waiting on a model. Derived, so the split needs
      // no per-tool timing.
      toolMs: Math.max(0, durationMs - llmMs),
      models: [...new Set(served.map((a) => `${a.provider}:${a.model}`))],
      tokens: { ...tok, total: tok.input + tok.output },
      cost: {
        billedUsd: attempts.reduce((a, x) => a + (x.billedUsd || 0), 0),
        listUsd: withPrice.length ? withPrice.reduce((a, x) => a + x.listUsd, 0) : null,
        priced,
      },
      attempts,
    };
  }

  return {
    summary,

    /** The chain actually used. Resolved after flows, so it is set late. */
    setTask(t) {
      task = t;
    },

    recordStep() {
      steps += 1;
    },

    /**
     * One completed request, success or failure.
     *
     * Fires on BOTH branches on purpose. A failed attempt still spent a slot in
     * the quota bucket and still cost wall-clock, and a fallback cascade is
     * exactly when that matters — recording only successes would go quiet at
     * the moment there is most to explain.
     */
    recordResult({ provider, model, ok, usage = null, latencyMs = 0, errorKind = null }) {
      llmMs += latencyMs;
      const { listUsd } = ok && usage
        ? estimateCost(provider, model, usage)
        : { listUsd: null };

      attempts.push({
        provider, model, ok, latencyMs,
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        reasoning: usage?.reasoning ?? 0,
        cached: usage?.cached ?? 0,
        // What the provider says it charged. Ones that stay silent contribute
        // 0, which is correct on a free tier and the reason a list figure is
        // reported next to it.
        billedUsd: usage?.billedUsd ?? 0,
        listUsd,
        errorKind,
      });
    },

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
      const s = summary(outcome);
      const { durationMs } = s;
      const { istDate, ptDate } = dayKeys();

      const mix = Object.entries(byModel).map(([m, c]) => `${m}×${c}`).join(" ") || "none";
      const money = s.cost.listUsd === null
        ? "unpriced"
        : `$${s.cost.listUsd.toFixed(6)}${s.cost.priced ? "" : "+"} list`;
      console.log(
        `[usage] turn done: calls=${calls} [${mix}] source=${source} ` +
          `outcome=${outcome} ${durationMs}ms (llm ${s.llmMs}ms / tools ${s.toolMs}ms) ` +
          `tok ${s.tokens.input}in/${s.tokens.output}out` +
          (s.tokens.reasoning ? ` (${s.tokens.reasoning} reasoning)` : "") +
          ` ${money}`
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
              tokensIn: s.tokens.input,
              tokensOut: s.tokens.output,
              tokensReasoning: s.tokens.reasoning,
              billedUsd: s.cost.billedUsd,
              listUsd: s.cost.listUsd ?? 0,
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

      return s;
    },
  };
}
