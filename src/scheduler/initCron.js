import cron from "node-cron";
import { getDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import executeTriggerJob from "./executeTriggerJob.js";
import { getAllUsersWithTriggers } from "../agent/userManager.js";
import { goodMorningJob } from "./jobs/goodMorningJob.js";
import { goodNightJob } from "./jobs/goodNightJob.js";

export default function initCron() {
	// 1. Existing DB-based triggers executor
	cron.schedule("* * * * *", async () => {
		try {
			await triggerExecutor();
		} catch (err) {
			console.error("Cron execution error:", err);
		}
	});

	// 2. Multi-user Global Morning Job (Runs every hour at minute 0)
	// Instead of one DB trigger, we iterate over all users and check if 
	// their local time matches their preferred morning schedule (default 9 AM).
	cron.schedule("0 * * * *", async () => {
		try {
			await globalUserRoutineExecutor("morning", 9); // 9 AM local
		} catch (err) {
			console.error("Morning Routine Cron error:", err);
		}
	});

	// 3. Multi-user Global Night Job (Runs every hour at minute 0)
	cron.schedule("0 * * * *", async () => {
		try {
			await globalUserRoutineExecutor("night", 23); // 11 PM local
		} catch (err) {
			console.error("Night Routine Cron error:", err);
		}
	});
}

async function globalUserRoutineExecutor(routineType, targetLocalHour) {
	const users = await getAllUsersWithTriggers();
	
	for (const user of users) {
		const tz = user.timezone || "Asia/Kolkata";
		// Get current hour in the user's timezone
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hour: "numeric",
			hour12: false
		});
		
		const currentLocalHour = parseInt(formatter.format(new Date()), 10);
		
		if (currentLocalHour === targetLocalHour) {
			console.log(`[Routine] Triggering ${routineType} for user ${user.userId} (${tz})`);
			if (routineType === "morning") {
				goodMorningJob(user).catch(err => console.error(`[Routine] Error morning job for ${user.userId}:`, err));
			} else {
				goodNightJob(user).catch(err => console.error(`[Routine] Error night job for ${user.userId}:`, err));
			}
		}
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