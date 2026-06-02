import { closeFlowByAgent } from "./activeFlowsRepo.js";

/**
 * Closes the user's currently-open flow of the given type. Called by the
 * agent via the `completeFlow` tool when the flow's overlay instruction
 * judges its completion criteria met.
 */
export async function completeFlow(userId, flowType, reason = "done") {
  if (!userId) throw new Error("[completeFlow] userId is required");
  if (!flowType) throw new Error("[completeFlow] flowType is required");

  const result = await closeFlowByAgent({ userId, flowType, reason });
  if (!result) {
    return { success: false, flowType, message: "no open flow of this type" };
  }
  return {
    success: true,
    flowType,
    state: result.state,
    reason: result.reason,
  };
}
