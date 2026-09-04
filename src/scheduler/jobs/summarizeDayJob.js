import { getDB } from "../../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../../tools/mongo/schema/triggerJobSchema.js";
import { CHAT_SUMMARY } from "../../tools/mongo/schema/chatSummarySchema.js";
import { createRecord } from "../../tools/mongo/createRecord.js";
import { summarizeDay } from "../../agent/summarize/summarizeDay.js";
import dayTranscriptKnowledge from "../../knowledge/dayTranscriptKnowledge.js";
import { findDaySummary, hasDaySummary } from "../../tools/mongo/operation/chatSummaries.js";
import { getUserProfile } from "../../identity/userManager.js";
import { IST_TIMEZONE, previousDay } from "../../tools/mongo/dateUtils.js";

/**
 * Writes one day into chatSummary, once that day's wrap-up is finished.
 *
 * Entered from the two places the goodNight flow can close — the agent calling
 * completeFlow because the user replied, and goodMorningJob superseding it
 * because they never did. Both go through onGoodNightClosed rather than calling
 * this directly.
 */

const ACTION_TYPE = "summarizeDayJob";

/**
 * How long after the goodNight flow closes the pass runs.
 *
 * Not zero, and the delay is the point. The agent path closes the flow from
 * INSIDE a live turn — completeFlow is usually the last tool call of the
 * wrap-up, and the reply and its chatHistory document are still to come.
 * Firing immediately would read a transcript missing the final exchange.
 */
const DELAY_MINUTES = 2;

/**
 * Queue the pass. Safe to call more than once for the same day.
 *
 * A triggerJob row rather than a setTimeout or an inline await: it survives a
 * restart, it reuses executeTriggerJob's claim and backoff, and it takes the
 * work off the caller's stack entirely — the user's "goodnight" must not wait
 * on a summarization.
 *
 * Written with the raw driver, like activeFlowsRepo. createRecord stamps the
 * owner from the bound user context, and one of the two callers has none bound
 * — getUserContext throws rather than defaulting, which is right there and the
 * wrong dependency here.
 */
export async function scheduleDaySummary({ userId, logDate, timeZone = IST_TIMEZONE, runAt = null }) {
    if (!Number.isInteger(userId)) throw new Error("[summarizeDayJob] userId must be an integer");
    if (!logDate) throw new Error("[summarizeDayJob] logDate is required");

    const db = await getDB();

    if (await hasDaySummary(userId, logDate)) {
        console.log(`[summarizeDayJob] ${logDate} already summarised for ${userId} — not queueing`);
        return null;
    }

    // Both close paths can fire for one day: the user wraps up at 23:40 and the
    // morning job supersedes an already-closed flow at 09:00. The second is a
    // no-op on the flow but would still queue a row.
    const pending = await db.collection(TRIGGER_JOB).findOne({
        userId,
        actionType: ACTION_TYPE,
        status: { $in: ["active", "processing"] },
        "payload.logDate": logDate,
    });
    if (pending) {
        console.log(`[summarizeDayJob] ${logDate} already queued for ${userId}`);
        return null;
    }

    const now = new Date();
    const { insertedId } = await db.collection(TRIGGER_JOB).insertOne({
        title: `Summarise ${logDate}`,
        userId,
        type: "one_time",
        recurring: false,
        cronPattern: null,
        timeZone,
        actionType: ACTION_TYPE,
        payload: { userId, logDate, timeZone },
        status: "active",
        attempts: 0,
        maxAttempts: 3,
        lastExecutedAt: null,
        // runAt is for the backfill, which spaces a week of days an hour apart
        // so each one's summary exists before the next reads it as PREVIOUS
        // STATE. The nightly path leaves it null and takes the short delay.
        nextExecutionAt: runAt ?? new Date(now.getTime() + DELAY_MINUTES * 60 * 1000),
        expiryDate: null,
        failedAt: null,
        createdAt: now,
        updatedAt: now,
    });

    console.log(`[summarizeDayJob] queued ${logDate} for ${userId} (${insertedId})`);
    return insertedId;
}

/**
 * Read the day, summarise it, store the row.
 *
 * Dispatched by executeTriggerJob, which has already bound the user context
 * from the job row — which is what lets createRecord stamp the owner and what
 * scopes the reads.
 *
 * Throws on failure so the scheduler's retry and backoff apply. A day lost to a
 * quota block should be tried again, not silently dropped.
 */
export async function summarizeDayJob(userId, logDate, timeZone = IST_TIMEZONE) {
    if (await hasDaySummary(userId, logDate)) {
        console.log(`[summarizeDayJob] ${logDate} already summarised for ${userId} — skipping`);
        return { skipped: true, logDate };
    }

    let apiKeys = {};
    try {
        const profile = await getUserProfile(userId);
        apiKeys = profile?.apiKeys || {};
        timeZone = profile?.timezone || timeZone;
    } catch (e) {
        console.warn(`[summarizeDayJob] profile lookup failed, using shared keys: ${e.message}`);
    }

    const [transcript, previous] = await Promise.all([
        dayTranscriptKnowledge(userId, logDate, { timeZone }),
        findDaySummary(userId, previousDay(logDate)).catch(() => null),
    ]);

    const { row, provider, model } = await summarizeDay({
        userId, logDate, transcript, previous, timeZone, apiKeys,
    });

    // Through createRecord rather than the driver, so the row picks up
    // ValidateSchema and the owner stamp like every other write. The model
    // supplied only the content fields; userId, period and date were set from
    // arguments it never saw.
    const { insertedId } = await createRecord(CHAT_SUMMARY, row);

    console.log(`[summarizeDayJob] wrote ${logDate} for ${userId} via ${provider}:${model} — ${row.headline}`);
    return { skipped: false, logDate, insertedId, row };
}
