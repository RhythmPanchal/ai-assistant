import { runAgent } from "../../agent/agent.js";
import pendingTasksKnowledge from "../../knowledge/pendingTasksKnowledge.js";
import taskLogKnowledge from "../../knowledge/taskLogKnowledge.js";
import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow } from "../flows/activeFlowsRepo.js";
import { goodMorningFlow } from "../../agent/flows/goodMorningFlow.js";

export async function goodMorningJob() {
  // TODO: iterate real users once multi-user support lands
  const userId = 1136575387;

  const [pendingTasks, taskLogs] = await Promise.all([
    pendingTasksKnowledge(userId),
    taskLogKnowledge(userId),
  ]);

  // Flow must be open BEFORE runAgent so the morning overlay applies to
  // the draft turn as well as every follow-up confirmation turn.
  await openFlow({
    userId,
    flowType: goodMorningFlow.flowType,
    ttlMinutes: goodMorningFlow.ttlMinutes,
  });

  const triggerPrompt = goodMorningFlow.buildTriggerPrompt({
    pendingTasks,
    taskLogs,
  });

  try {
    const draftMessage = await runAgent(userId, triggerPrompt);
    return sendMessage(userId, draftMessage);
  } catch (error) {
    throw new Error(`Caught error while running Good morning job: ${error.message}`);
  }
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
