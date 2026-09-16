import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow, hasFlowStartedToday } from "../flows/activeFlowsRepo.js";
import { goodNightFlow } from "../../agent/flows/goodNightFlow.js";
import { resolveRoutineTargets, resolveAddress } from "../../identity/userManager.js";
import { runAgent, STEP_LIMIT_REPLY, WORK_DONE_REPLY } from "../../agent/agent.js";
import { NO_REPLY } from "../../agent/instruction.js";
import { runWithUserContext } from "../../identity/userContext.js";

// Shorter than this is not an opener — a stray "Hi" or a fragment of a
// failed generation. The template is better than either.
const MIN_OPENER_CHARS = 20;

/**
 * Tonight's first message, written for this person's day — or the fixed
 * template when that cannot be done.
 *
 * The template asked for food, tasks and spending as a four-bullet form, and
 * read like a logger. The written opener starts from what the day actually
 * held: a party mentioned at 18:30, lunch already logged, a plan that slipped.
 *
 * It runs as a real agent turn with the night flow already open, so the
 * overlay's OPENER section, the LOGGED SO FAR block and today's chat are all in
 * front of the model. The turn is persisted like any routine turn; its trigger
 * message is hidden from the day transcript.
 *
 * NEVER throws. A night with no opener is a night with nothing logged, so every
 * failure — an error, NO_REPLY, a canned runAgent substitute, a fragment — sends
 * the template instead. `generated` says which one went out.
 *
 * `run` is injectable for the same reason buildFlowOverlay takes `flows`: the
 * fallback is the path that matters, and the only way to exercise it for real
 * is to hand it a run that fails.
 *
 * @returns {Promise<{ text: string, generated: boolean }>}
 */
export async function composeNightOpener(userId, timeZone = "Asia/Kolkata", { run = runAgent } = {}) {
  const template = { text: goodNightFlow.openerMessage, generated: false };
  try {
    const { text } = await runWithUserContext(
      { userId, channel: "scheduler", reason: "goodNightJob" },
      () => run(userId, goodNightFlow.buildTriggerPrompt(), "goodNightJob")
    );
    const opener = text?.trim();
    const unusable = !opener
      || opener === NO_REPLY
      || opener === STEP_LIMIT_REPLY
      || opener === WORK_DONE_REPLY
      || opener.length < MIN_OPENER_CHARS;
    if (unusable) {
      console.warn(`[goodNightJob] opener for ${userId} came back unusable (${JSON.stringify(opener?.slice(0, 40))}) — sending the template`);
      return template;
    }
    return { text: opener, generated: true };
  } catch (err) {
    console.error(`[goodNightJob] opener for ${userId} failed (${err.message}) — sending the template`);
    return template;
  }
}

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
      // Resolved BEFORE the opener is written, so an undeliverable user does
      // not cost a model call.
      const address = await resolveAddress(userId);
      if (!address) {
        console.error(`[goodNightJob] no telegram identity for ${userId} — cannot deliver`);
        continue;
      }
      const { text, generated } = await composeNightOpener(userId, timeZone);
      console.log(`[goodNightJob] ${generated ? "written" : "template"} opener for ${userId}`);
      results.push(await sendMessage(address, text));
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
