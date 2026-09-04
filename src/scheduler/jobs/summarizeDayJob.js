import { getDB } from "../../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../../tools/mongo/schema/triggerJobSchema.js";
import { runAgent } from "../../agent/agent.js";
import { openFlow, closeFlow } from "../flows/activeFlowsRepo.js";
import summarizeFlow from "../../agent/flows/summarizeFlow.js";
import { hasDaySummary } from "../../tools/mongo/operation/chatSummaries.js";
import { runWithUserContext } from "../../identity/userContext.js";
import { IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";

/**
 * Writes one day into chatSummary, once that day's wrap-up is finished.
 *
 * Entered from the two places the goodNight flow can close:
 *   - the agent calls completeFlow, because the user replied and wrapped up
 *   - goodMorningJob supersedes it the next morning, because they never did
 * Both go through scheduleDaySummary below rather than calling this directly.
 */

const ACTION_TYPE = "summarizeDayJob";

/**
 * How long after the goodNight flow closes the pass runs.
 *
 * Not zero, and the delay is the point. The agent path closes the flow from
 * INSIDE a live turn — completeFlow is usually the last tool call of the
 * wrap-up, and the reply and its chatHistory document are still to come. Firing
 * immediately would read a transcript missing the final exchange, and would put
 * a second concurrent agent run on a user whose turns are otherwise strictly
 * serial. Two minutes is comfortably past both.
 */
const DELAY_MINUTES = 2;

/**
 * Queue the pass. Safe to call more than once for the same day.
 *
 * A triggerJob row rather than a setTimeout or an inline await, for three
 * reasons: it survives a restart, it reuses executeTriggerJob's claim and
 * backoff, and it takes the work off the caller's stack entirely — the user's
 * "goodnight" must not wait on a summarization.
 *
 * Written with the raw driver, like activeFlowsRepo. createRecord stamps the
 * owner from the bound user context, and one of the two callers (goodMorningJob's
 * supersede) has no context bound — getUserContext throws rather than defaulting,
 * which is the correct behaviour there and the wrong dependency here.
 */
export async function scheduleDaySummary({ userId, logDate, timeZone = IST_TIMEZONE }) {
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
        nextExecutionAt: new Date(now.getTime() + DELAY_MINUTES * 60 * 1000),
        expiryDate: null,
        failedAt: null,
        createdAt: now,
        updatedAt: now,
    });

    console.log(`[summarizeDayJob] queued ${logDate} for ${userId} (${insertedId})`);
    return insertedId;
}

/**
 * Run the pass. Dispatched by executeTriggerJob, which has already bound the
 * user context from the job row.
 *
 * Throws on failure rather than swallowing, so the scheduler's retry and
 * backoff apply — a summarization that fails on a quota block should be tried
 * again, not silently lose the day.
 */
export async function summarizeDayJob(userId, logDate, timeZone = IST_TIMEZONE) {
    if (await hasDaySummary(userId, logDate)) {
        console.log(`[summarizeDayJob] ${logDate} already summarised for ${userId} — skipping`);
        return { skipped: true, logDate };
    }

    // The day being summarised is NOT the day this opens on — the no-reply path
    // runs the morning after. flowStateBlock reads this in preference to
    // startedAt, which is what stops every row being filed a day late.
    await openFlow({
        userId,
        flowType: summarizeFlow.flowType,
        expiresAt: summarizeFlow.computeExpiry(timeZone),
        scratchpad: { logDate },
    });

    try {
        // Bound here for the same reason the routine jobs bind it: this acts on
        // a user's behalf without that user having sent anything, so it has to
        // declare who it is acting as before it dispatches a single tool.
        const reply = await runWithUserContext(
            { userId, channel: "scheduler", reason: ACTION_TYPE },
            () => runAgent(userId, summarizeFlow.buildTriggerPrompt(logDate), "summarizeJob")
        );
        console.log(`[summarizeDayJob] ${logDate} for ${userId}: ${reply}`);

        // The agent reporting success is not evidence the row exists — HARD RULE
        // 1 exists precisely because it says "saved" without having saved. Check.
        if (!(await hasDaySummary(userId, logDate))) {
            throw new Error(`summarize pass for ${logDate} finished without writing a row`);
        }

        return { skipped: false, logDate, reply };
    } finally {
        // In a finally so a thrown turn cannot leave the flow open. It would
        // expire on its own in 20 minutes, but until then the retry would see a
        // stale flow and openFlow would supersede it rather than reuse it.
        await closeFlow({
            userId,
            flowType: summarizeFlow.flowType,
            reason: "summarize pass finished",
        }).catch(e => console.warn(`[summarizeDayJob] could not close flow: ${e.message}`));
    }
}
