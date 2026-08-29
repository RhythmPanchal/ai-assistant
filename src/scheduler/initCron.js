import cron from "node-cron";
import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import executeTriggerJob from "./executeTriggerJob.js";
import { resolveRoutineTargets } from "../identity/userManager.js";
import { goodMorningJob } from "./jobs/goodMorningJob.js";
import { goodNightJob } from "./jobs/goodNightJob.js";

// Local hour at which each routine fires, in each user's own timezone.
const ROUTINE_HOURS = { morning: 9, night: 23 };

export default function initCron() {
	cron.schedule("* * * * *", async () => {
		try {
			await triggerExecutor();
		} catch (err) {
			console.error("Cron execution error:", err);
		}
	});

	// Hourly so each user's routine can fire at their own local hour. Safe to
	// run alongside the legacy triggerJob rows: both paths funnel through
	// hasFlowStartedToday, so a user gets at most one routine per local day.
	cron.schedule("0 * * * *", async () => {
		try {
			await routineExecutor();
		} catch (err) {
			console.error("Routine cron error:", err);
		}
	});
}

async function routineExecutor() {
	const users = await resolveRoutineTargets();

	for (const user of users) {
		const timeZone = user.timezone || "Asia/Kolkata";
		// hourCycle h23 — "en-US" with hour12:false reports midnight as 24.
		const hour = Number(
			new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" })
				.format(new Date())
		);

		const job =
			hour === ROUTINE_HOURS.morning ? goodMorningJob :
			hour === ROUTINE_HOURS.night ? goodNightJob : null;
		if (!job) continue;

		await job(user).catch(err =>
			console.error(`[routineExecutor] ${job.name} failed for ${user.userId}:`, err.message)
		);
	}
}

/**
 * Retire jobs that are past their expiryDate.
 *
 * expiryDate has been written since the beginning — it is what "remind me for
 * a month" produces — but nothing ever read it back, so every recurring job
 * ever created was immortal. "Call Masi" was still firing five weeks past its
 * expiry, and a weekly job that expired in July still fired in August.
 *
 * This runs as a sweep rather than only as a filter on the due query below,
 * because a job whose expiry passed while it was not due would otherwise sit
 * in the active set looking live until its next fire date arrived.
 */
async function retireExpiredJobs(db, now) {
	// $ne: null states the intent rather than carrying it: Mongo type-brackets
	// range operators, so { $lte: <Date> } already skips null and missing. Kept
	// explicit because "never retire a job that has no expiry" is the one thing
	// this updateMany must not get wrong.
	const { modifiedCount } = await db.collection(TRIGGER_JOB).updateMany(
		{ status: "active", expiryDate: { $ne: null, $lte: now } },
		{ $set: { status: "completed", nextExecutionAt: null, updatedAt: now } }
	);

	if (modifiedCount > 0) {
		console.log(`[triggerExecutor] Retired ${modifiedCount} expired job(s).`);
	}
}

async function triggerExecutor() {
	const db = await getDB();
	const now = new Date();

	await retireExpiredJobs(db, now);

	const pendingTriggers = await db
		.collection(TRIGGER_JOB)
		.find({
			status : "active",
			nextExecutionAt: { $lte: now },
			// Behind the sweep above, not instead of it: an expired job must not
			// dispatch even on a tick where the sweep failed. All three branches
			// are needed — type bracketing means { $gt: <Date> } matches neither
			// null nor a missing field, so on its own it would drop every job
			// that has no expiry, which is most of them.
			$or: [
				{ expiryDate: null },
				{ expiryDate: { $exists: false } },
				{ expiryDate: { $gt: now } },
			],
		})
		.toArray();

	// console.log(`[Trigger Executor] found ${pendingTriggers.length} pending triggers. [ ${pendingTriggers.join(" ")} ] at ${now}`);
	return processTriggers(pendingTriggers);
}

export async function processTriggers(TriggerJobs) {
	if (TriggerJobs.length == 0) {
		return;
	}

	const results = await Promise.allSettled(
		TriggerJobs.map((job) => executeTriggerJob(job) )
	); 

	results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[processTriggers] Job ${TriggerJobs[index]._id} failed:`, result.reason);
    } else {
      console.log(`[processTriggers] Job ${TriggerJobs[index]._id} completed successfully.`);
    }
  });
}