import { runAgent } from "../../agent/agent.js";
import { getDB } from "../../tools/mongo/mongoClient.js";
import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow } from "../flows/activeFlowsRepo.js";
import { goodNightFlow } from "../../agent/flows/goodNightFlow.js";

export async function goodNightJob(user) {
  const userId = user.userId;

  // Flow must be open BEFORE runAgent so the night overlay applies to
  // the draft turn as well as every follow-up confirmation turn.
  await openFlow({
    userId,
    flowType: goodNightFlow.flowType,
    ttlMinutes: goodNightFlow.ttlMinutes,
  });

  const triggerPrompt = goodNightFlow.buildTriggerPrompt();

  try {
    const draftMessage = await runAgent(userId, triggerPrompt, user);
    return await sendMessage(userId, draftMessage);
  } catch (error) {
    throw new Error(`Caught error while running Good night job for user ${userId}: ${error.message}`);
  }
}
