import { getDB } from "../../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../../tools/mongo/schema/triggerJobSchema.js";
import { CHAT_SUMMARY } from "../../tools/mongo/schema/chatSummarySchema.js";
import { USER_SCHEDULE } from "../../tools/mongo/schema/userScheduleSchema.js";
import { TASK_REGISTER } from "../../tools/mongo/schema/taskRegisterSchema.js";
import { createRecord } from "../../tools/mongo/createRecord.js";
import { buildDayRecord } from "../../agent/summarize/dayRecord.js";
import dayTranscriptKnowledge from "../../knowledge/dayTranscriptKnowledge.js";
import { findDaySummary, hasDaySummary } from "../../tools/mongo/operation/chatSummaries.js";
import { getUserProfile } from "../../identity/userManager.js";
import { IST_TIMEZONE, localDayRange, previousDay } from "../../tools/mongo/dateUtils.js";

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
 * The plan and the log the day is measured against. The newest schedule wins
 * if a day somehow holds two — the same pick updateSchedule makes.
 */
async function readPlanAndLog(userId, logDate) {
    const { start, end } = localDayRange(logDate);
    const day = { userId, date: { $gte: start, $lt: end } };
    const db = await getDB();
    const [schedule, taskLogs] = await Promise.all([
        db.collection(USER_SCHEDULE).find(day).sort({ _id: -1 }).limit(1).next(),
        db.collection(TASK_REGISTER).find(day).toArray(),
    ]);
    return { schedule, taskLogs };
}

/**
 * Read the day, review and summarise it, store the row.
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

    const [transcript, previous, { schedule, taskLogs }] = await Promise.all([
        dayTranscriptKnowledge(userId, logDate, { timeZone }),
        findDaySummary(userId, previousDay(logDate)).catch(() => null),
        readPlanAndLog(userId, logDate),
    ]);

    const { row, models } = await buildDayRecord({
        userId, logDate, transcript, previous, schedule, taskLogs, timeZone, apiKeys,
    });

    // Through createRecord rather than the driver, so the row picks up
    // ValidateSchema and the owner stamp like every other write. The models
    // supplied only content, matches and scores; userId, period, date and every
    // number in productivity were set in code.
    const { insertedId } = await createRecord(CHAT_SUMMARY, row);

    const p = row.productivity;
    console.log(
        `[summarizeDayJob] wrote ${logDate} for ${userId} via ${models.summary} (review ${models.review}) — ${row.headline} ` +
        `· ${p.verdict}, productivity ${p.score ?? "-"}/5`
    );
    return { skipped: false, logDate, insertedId, row };
}
