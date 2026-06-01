import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow } from "../flows/activeFlowsRepo.js";
import { goodNightFlow } from "../../agent/flows/goodNightFlow.js";

export async function goodNightJob() {
  // TODO: iterate real users once multi-user support lands
  const userId = 1136575387;

  await openFlow({
    userId,
    flowType: goodNightFlow.flowType,
    ttlMinutes: goodNightFlow.ttlMinutes,
  });

  return sendMessage(userId, goodNightFlow.openerMessage);
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
