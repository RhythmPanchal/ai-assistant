import { runAgent } from "../../agent/agent.js";
import { NO_REPLY } from "../../agent/instruction.js";
import pendingTasksKnowledge from "../../knowledge/pendingTasksKnowledge.js";
import taskLogKnowledge from "../../knowledge/taskLogKnowledge.js";
import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow, closeFlow, hasFlowStartedToday } from "../flows/activeFlowsRepo.js";
import { goodMorningFlow } from "../../agent/flows/goodMorningFlow.js";
import { goodNightFlow } from "../../agent/flows/goodNightFlow.js";
import { resolveRoutineTargets } from "../../agent/userManager.js";

/**
 * @param {Object} [user] fire for just this user; omit to fire for everyone
 *                        opted in (or the legacy user if none are).
 */
export async function goodMorningJob(user) {
  const targets = await resolveRoutineTargets(user);
  const results = [];

  for (const target of targets) {
    const { userId } = target;
    const timeZone = target.timezone || "Asia/Kolkata";

    // This job is the most expensive thing the agent does. Running it twice
    // in a day is pure waste, and both a restart and a legacy triggerJob row
    // can re-enter here.
    if (await hasFlowStartedToday(userId, goodMorningFlow.flowType, timeZone)) {
      console.log(`[goodMorningJob] already ran today for ${userId} — skipping`);
      continue;
    }

    try {
      const [pendingTasks, taskLogs] = await Promise.all([
        pendingTasksKnowledge(userId),
        taskLogKnowledge(userId),
      ]);

      // Flow must be open BEFORE runAgent so the morning overlay applies to
      // the draft turn as well as every follow-up confirmation turn.
      // Last night's wrap-up is over the moment a new day is planned. This is
      // what actually ends the night flow — its expiry is only a backstop.
      await closeFlow({
        userId,
        flowType: goodNightFlow.flowType,
        reason: "superseded by the new day",
      });

      await openFlow({
        userId,
        flowType: goodMorningFlow.flowType,
        expiresAt: goodMorningFlow.computeExpiry(timeZone),
      });

      const draftMessage = await runAgent(
        userId,
        goodMorningFlow.buildTriggerPrompt({ pendingTasks, taskLogs }),
        "goodMorningJob"
      );

      // The whole point of this job is to send a draft, so NO_REPLY here is a
      // failure, not a decision — the user would otherwise get silence with no
      // trace of why.
      if (!draftMessage || draftMessage.trim() === NO_REPLY) {
        console.error(`[goodMorningJob] agent returned no draft for ${userId} — nothing sent`);
        continue;
      }

      results.push(await sendMessage(userId, draftMessage));
    } catch (error) {
      // One user's failure must not stop the rest, but the error still has to
      // reach executeTriggerJob so a quota block is classified and rescheduled.
      console.error(`[goodMorningJob] failed for ${userId}:`, error.message);
      if (targets.length === 1) throw error;
    }
  }

  return results;
}

/* current job in mongo
{
  "title": "Good Morning Routine",
  "userId": -1,
  "type": "recurring",
  "recurring": true,
  "cronPattern": "0 9 * * *",
  "timeZone": "Asia/Kolkata",
  "actionType": "goodMorningJob",
  "payload": {},
  "status": "active",
  "attempts": 0,
  "maxAttempts": 3,
  "lastExecutedAt": null,
  "nextExecutionAt": { "$date": "2026-03-31T08:30:00.000Z" },
  "expiryDate": null,
  "failedAt": null,
  "createdAt": { "$date": "2026-03-30T00:00:00.000Z" },
  "updatedAt": { "$date": "2026-03-30T00:00:00.000Z" }
}
*/
