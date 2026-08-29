import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import { ObjectId } from "mongodb";
import { dispatchAction } from "./actionDispatcher.js";
import { runWithUserContext } from "../identity/userContext.js";
import { CronExpressionParser } from "cron-parser";
import { classifyQuotaError } from "../agent/llm/usageMeter.js";

// Exponential backoff between in-process retries:
// attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s.
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function executeTriggerJob(job) {
    const db = await getDB();
    const collection = db.collection(TRIGGER_JOB);
    const now = new Date();
    console.log(job);
    // ─── 1. Mark as processing ───────────────────────────────────────────────
    const updatedJob = await collection.findOneAndUpdate(
        { _id: job._id, status: "active" },
        { $set: { status: "processing", updatedAt: now } },
        { returnDocument: "after" }
    );
    
    if (!updatedJob) {
        throw new Error(`[executeTriggerJob] Job ${job._id} is not active. Skipping.`);
    }

    // ─── 2. Execute the action ───────────────────────────────────────────────
    try {
        console.log(updatedJob.actionType, updatedJob.payload); 
        // The fourth entry point. A job acts for the user named on the row, and
        // that userId was written by the system rather than supplied by a model,
        // so it is the right thing to bind. Without this every scheduler-driven
        // write lands with no context and throws.
        const res = await runWithUserContext(
            { userId: updatedJob.userId, channel: "scheduler", reason: updatedJob.actionType },
            () => dispatchAction(updatedJob.actionType, updatedJob.payload)
        );
        console.log("[executeTriggerJob] job function result",res); 
        //TODO : handle the results. 
        // ─── 3a. Success ─────────────────────────────────────────────────────
        const { status, nextExecutionAt } = updatedJob.recurring
            ? scheduleNextRun(updatedJob)
            : { status: "completed", nextExecutionAt: null };

        await collection.updateOne(
            { _id: job._id },
            {
                $set: {
                    status,
                    lastExecutedAt: now,
                    attempts: 0,
                    nextExecutionAt,
                    updatedAt: new Date(),
                },
            }
        );

        console.log(`[executeTriggerJob] Job ${job._id} completed successfully.`);
        return true; 
    } catch (err) {
        console.error(`[executeTriggerJob] Job ${job._id} failed on attempt ${updatedJob.attempts + 1}:`, err.message);

        const attempts = (updatedJob.attempts ?? 0) + 1;
        const maxAttempts = updatedJob.maxAttempts ?? 3;

        // ─── 3a-bis. Daily LLM quota — retrying cannot help ──────────────────
        // Jobs that call runAgent (goodMorningJob) cost many requests per run.
        // Retrying re-runs the WHOLE agent loop, so one exhausted morning job
        // became three, each burning what little quota was left. Reschedule
        // instead of retrying.
        if (classifyQuotaError(err).kind === "RPD") {
            const { status, nextExecutionAt } = updatedJob.recurring
                ? scheduleNextRun(updatedJob)
                // don't lose a one-time job
                : { status: "active", nextExecutionAt: new Date(Date.now() + 60 * 60 * 1000) };

            await collection.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status,
                        attempts: 0,
                        failedAt: new Date(),
                        nextExecutionAt,
                        updatedAt: new Date(),
                    },
                }
            );
            console.warn(
                `[executeTriggerJob] Job ${job._id} hit the daily LLM quota — not retrying. Next run: ${nextExecutionAt}`
            );
            return false;
        }

        // ─── 3b. Failure — retry if attempts remaining ───────────────────────
        if (attempts < maxAttempts) {
            await collection.updateOne(
                { _id: new ObjectId(job._id) },
                {
                    $set: {
                        status: "active",
                        attempts,
                        updatedAt: new Date(),
                    },
                }
            );

            const backoffMs = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
            console.log(`[executeTriggerJob] Retrying job ${job._id} in ${backoffMs}ms. Attempt ${attempts}/${maxAttempts}.`);
            await delay(backoffMs);
            return executeTriggerJob({ ...updatedJob, attempts, status: "active" });
        }

        // ─── 3c. Failure — max attempts exceeded ─────────────────────────────
        if (updatedJob.recurring) {
            // For recurring jobs — reset attempts and schedule the next run,
            // unless that run would fall past the job's expiry.
            const { status, nextExecutionAt } = scheduleNextRun(updatedJob);

            await collection.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status,
                        attempts: 0,
                        failedAt: new Date(),
                        nextExecutionAt : nextExecutionAt,
                        updatedAt: new Date(),
                    },
                }
            );

            console.warn(`[executeTriggerJob] Recurring job ${job._id} failed all attempts. Skipping to next schedule: ${nextExecutionAt}`);

        } else {
            // For one_time jobs — permanently mark as failed
            await collection.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "failed",
                        attempts,
                        failedAt: new Date(),
                        updatedAt: new Date(),
                    },
                }
            );

            console.error(`[executeTriggerJob] Job ${job._id} permanently failed after ${attempts} attempts.`);
        }
        console.error(`[executeTriggerJob] Job ${job._id} permanently failed after ${attempts} attempts.`);
        return false; 
    }
}

// ─── Helper: where a recurring job goes next ───────────────────────────────
/**
 * Returns the status and next fire time for a recurring job, honouring
 * expiryDate.
 *
 * Three separate branches above each had their own copy of getNextCronDate —
 * success, quota deferral, and exhausted retries — and none of them looked at
 * expiryDate, so a job that had run its course rescheduled itself forever no
 * matter which path it took. Putting the check here covers all three.
 *
 * A job whose next fire lands past its expiry is "completed", not "cancelled":
 * it ran the schedule it was given. "cancelled" is for a user calling it off.
 */
export function scheduleNextRun(job) {
    const nextExecutionAt = getNextCronDate(job.cronPattern, job.timeZone);

    if (job.expiryDate && nextExecutionAt && nextExecutionAt > job.expiryDate) {
        return { status: "completed", nextExecutionAt: null };
    }

    return { status: "active", nextExecutionAt };
}

// ─── Helper: compute next cron execution date ──────────────────────────────
/**
 * The job's own timeZone decides when its cron fires. It used to be accepted
 * and then ignored in favour of a hardcoded "Asia/Kolkata", which was
 * invisible while every row was IST but silently wrong the moment a user in
 * another timezone got a recurring reminder.
 */
export function getNextCronDate(cronPattern, timeZone) {
    if (!cronPattern) return null;

    const tz = timeZone || "Asia/Kolkata";

    try{
        const interval = CronExpressionParser.parse(cronPattern, { tz });
        const nextExecutionAt = interval.next();
        const nextEexcutionAtDate = nextExecutionAt.toDate();

        return nextEexcutionAtDate;
    }catch(e){
        throw new Error(`Invalid cron expression "${cronPattern}" for timeZone "${tz}": ${e.message}`);
    }
}
