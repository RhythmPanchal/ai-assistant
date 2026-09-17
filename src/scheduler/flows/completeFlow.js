import { closeFlowByAgent, getOpenFlowsForUser } from "./activeFlowsRepo.js";
import { getUserProfile } from "../../identity/userManager.js";
import { onGoodNightClosed } from "../jobs/onGoodNightClosed.js";
import goodNightFlow from "../../agent/flows/goodNightFlow.js";
import onboardingFlow, { unfinishedSections } from "../../agent/flows/onboardingFlow.js";
import { markOnboarded } from "../../tools/mongo/operation/onboarding.js";

/**
 * Closes the user's currently-open flow of the given type. Called by the
 * agent via the `completeFlow` tool when the flow's overlay instruction
 * judges its completion criteria met.
 */
export async function completeFlow(userId, flowType, reason = "done") {
  if (!userId) throw new Error("[completeFlow] userId is required");
  if (!flowType) throw new Error("[completeFlow] flowType is required");

  // Onboarding cannot be declared done with a section still empty — see
  // unfinishedSections. Checked BEFORE closing, so a refusal leaves the flow
  // open and the conversation carries on. "skipped" is not gated: someone who
  // stopped answering is not held in onboarding.
  //
  // Only while one is open. Judged with none open, a refusal sent a model back
  // to "fix" the notes of an onboarding that had already closed — and it wrote
  // a skip over the answer it had just saved.
  if (flowType === onboardingFlow.flowType && reason === "done") {
    const open = await getOpenFlowsForUser(userId);
    const empty = open.some(f => f.flowType === onboardingFlow.flowType)
      ? unfinishedSections(await getUserProfile(userId))
      : [];
    if (empty.length) {
      // No hint about "Prefers not to say." here: suggesting it is what taught
      // a model to write it for questions it never asked.
      return {
        success: false,
        notFinished: true,
        flowType,
        stillEmpty: empty,
        message: `onboarding is not finished — still empty: ${empty.join(", ")} — ask about the next one.`,
      };
    }
  }

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

  // Finishing onboarding is what marks them onboarded and switches routines on.
  // Awaited, unlike the night hook: the model's closing reply tells them whether
  // their routines just started, so the answer has to exist before it writes it.
  // A skipped onboarding marks nothing — they can /start again to finish.
  let onboarding;
  if (flowType === onboardingFlow.flowType && reason === "done") {
    onboarding = await markOnboarded(userId);
  }

  return {
    success: true,
    flowType,
    state: result.state,
    reason: result.reason,
    ...(onboarding ? { onboarding } : {}),
  };
}
