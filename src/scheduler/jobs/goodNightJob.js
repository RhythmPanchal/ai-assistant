import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow, hasFlowStartedToday } from "../flows/activeFlowsRepo.js";
import { goodNightFlow } from "../../agent/flows/goodNightFlow.js";
import { resolveRoutineTargets, resolveAddress } from "../../identity/userManager.js";

/**
 * @param {Object} [user] fire for just this user; omit to fire for everyone
 *                        opted in (or the legacy user if none are).
 */
export async function goodNightJob(user) {
  const targets = await resolveRoutineTargets(user);
  const results = [];

  for (const target of targets) {
    const { userId } = target;
    const timeZone = target.timezone || "Asia/Kolkata";

    if (await hasFlowStartedToday(userId, goodNightFlow.flowType, timeZone)) {
      console.log(`[goodNightJob] already ran today for ${userId} — skipping`);
      continue;
    }

    try {
      await openFlow({
        userId,
        flowType: goodNightFlow.flowType,
        expiresAt: goodNightFlow.computeExpiry(timeZone),
      });
      // userId is an identity, not a chat id. They were the same number for
      // the original single user; sending to it now delivers nowhere.
      const address = await resolveAddress(userId);
      if (!address) {
        console.error(`[goodNightJob] no telegram identity for ${userId} — cannot deliver`);
        continue;
      }
      results.push(await sendMessage(address, goodNightFlow.openerMessage));
    } catch (error) {
      console.error(`[goodNightJob] failed for ${userId}:`, error.message);
      if (targets.length === 1) throw error;
    }
  }

  return results;
}

/* current job in mongo
{
  "title": "Good Night Routine",
  "userId": -1,
  "type": "recurring",
  "recurring": true,
  "cronPattern": "0 23 * * *",
  "timeZone": "Asia/Kolkata",
  "actionType": "goodNightJob",
  "payload": {},
  "status": "active",
  "attempts": 0,
  "maxAttempts": 3,
  "lastExecutedAt": null,
  "nextExecutionAt": { "$date": "2026-03-30T22:30:00.000Z" },
  "expiryDate": null,
  "failedAt": null,
  "createdAt": { "$date": "2026-03-30T00:00:00.000Z" },
  "updatedAt": { "$date": "2026-03-30T00:00:00.000Z" }
}
*/
