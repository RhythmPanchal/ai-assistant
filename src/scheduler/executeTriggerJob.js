import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import { ObjectId } from "mongodb";
import { dispatchAction } from "./actionDispatcher.js";
import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";

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
        const res = await dispatchAction(updatedJob.actionType, updatedJob.payload);
        console.log("[executeTriggerJob] job function result",res); 
        //TODO : handle the results. 
        // ─── 3a. Success ─────────────────────────────────────────────────────
        const nextExecutionAt = updatedJob.recurring
            ? getNextCronDate(updatedJob.cronPattern, updatedJob.timeZone)
            : null;

        await collection.updateOne(
            { _id: job._id },
            {
                $set: {
                    status: updatedJob.recurring ? "active" : "completed",
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

            console.log(`[executeTriggerJob] Retrying job ${job._id}. Attempt ${attempts}/${maxAttempts}.`);
            return executeTriggerJob({ ...updatedJob, attempts, status: "active" });
        }

        // ─── 3c. Failure — max attempts exceeded ─────────────────────────────
        if (updatedJob.recurring) {
            // For recurring jobs — reset attempts, keep active, schedule next run
            const nextExecutionAt = getNextCronDate(updatedJob.cronPattern, updatedJob.timeZone);

            await collection.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "active",
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

// ─── Helper: compute next cron execution date ──────────────────────────────
export function getNextCronDate(cronPattern, timeZone) {
    if (!cronPattern) return null;

    try{
        const interval = CronExpressionParser.parse(cronPattern, { tz: "Asia/Kolkata", });
        const nextExecutionAt = interval.next();
        const nextEexcutionAtDate = nextExecutionAt.toDate();

        return nextEexcutionAtDate; 
    }catch(e){
        throw new Error(`Invalid Cron Expression : "${cronPattern}" `); 
    }
}
