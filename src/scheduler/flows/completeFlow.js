import { closeFlowByAgent } from "./activeFlowsRepo.js";
import { onGoodNightClosed } from "../jobs/onGoodNightClosed.js";
import goodNightFlow from "../../agent/flows/goodNightFlow.js";

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

  // The wrap-up ending is what makes the day summarisable — nothing more will
  // be said about it. This is the path where the user actually replied; the
  // path where they never did is goodMorningJob's supersede.
  //
  // Not awaited. This runs inside the user's own live turn, as the last tool
  // call of their wrap-up, and they must not wait on it. onGoodNightClosed only
  // queues a row for the scheduler to pick up, so there is nothing here worth
  // holding the reply for.
  if (flowType === goodNightFlow.flowType) {
    onGoodNightClosed(result).catch(e =>
      console.error(`[completeFlow] could not queue the day summary: ${e.message}`)
    );
  }

  return {
    success: true,
    flowType,
    state: result.state,
    reason: result.reason,
  };
}
