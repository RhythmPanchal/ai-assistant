import cron from "node-cron";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import executeTriggerJob from "./executeTriggerJob.js";


export default function initCron() {
	let state = 1;

	cron.schedule("* * * * *", async () => {
		try {
			triggerExecutor();
		} catch (err) {
			console.error("Cron execution error:", err);
		}
	});

}

async function triggerExecutor() {
	const db = await getDB();
	const now = new Date();

	const pendingTriggers = await db
		.collection(TRIGGER_JOB)
		.find({ nextExecutionAt: { $lte: now } })
		.toArray();

	console.log(`[Trigger Executor] found ${pendingTriggers.length} pending triggers. [ ${pendingTriggers.join(" ")} ] at ${now}`);
	return processTriggers(pendingTriggers);
}

async function processTriggers(TriggerJobs) {
	if (TriggerJobs.length == 0) {
		return;
	}

	const results = await Promise.allSettled(
		TriggerJobs.map((job) => executeTriggerJob(job) )
	); 

	results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[processTriggers] Job ${pendingTriggers[index]._id} failed:`, result.reason);
    } else {
      console.log(`[processTriggers] Job ${pendingTriggers[index]._id} completed successfully.`);
    }
  });
}