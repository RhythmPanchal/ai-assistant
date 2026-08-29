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

async function triggerExecutor() {
	const db = await getDB();
	const now = new Date();

	const pendingTriggers = await db
		.collection(TRIGGER_JOB)
		.find({ 
			status : "active",
			nextExecutionAt: { $lte: now } })
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