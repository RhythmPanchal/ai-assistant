import { runAgent } from "../../agent/agent.js";
import pendingTasksKnowledge from "../../knowledge/pendingTasksKnowledge.js";
import taskLogKnowledge from "../../knowledge/taskLogKnowledge.js";
import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow } from "../flows/activeFlowsRepo.js";
import { goodMorningFlow } from "../../agent/flows/goodMorningFlow.js";

export async function goodMorningJob(user) {
  const userId = user.userId;

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
    const draftMessage = await runAgent(userId, triggerPrompt, user);
    return await sendMessage(userId, draftMessage);
  } catch (error) {
    throw new Error(`Caught error while running Good morning job for user ${userId}: ${error.message}`);
  }
}
