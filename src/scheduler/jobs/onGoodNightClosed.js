import { localDateOf, IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";
import { getUserProfile } from "../../identity/userManager.js";

/**
 * The single place a closed goodNight flow turns into a queued day summary.
 *
 * Both close paths land here — the agent's completeFlow when the user wrapped
 * up, and goodMorningJob's supersede when they never replied — so the rule for
 * WHICH day gets summarised is written once. It is the day the wrap-up flow
 * OPENED on, never the day it closed on: a wrap-up typed at 02:40 belongs to the
 * day that ended, and the no-reply path closes at 09:00 the following morning.
 *
 * The third exit, lazy expiry at 10:00, is deliberately not hooked. It is only
 * reached when goodMorningJob never ran, and it fires from inside
 * getOpenFlowsForUser — which is on the per-turn hot path, where starting a
 * background job does not belong.
 *
 * @param {object} flow the goodNight flow document as it was closed
 */
export async function onGoodNightClosed(flow) {
    if (!flow?.userId) return null;

    let timeZone = IST_TIMEZONE;
    try {
        const profile = await getUserProfile(flow.userId);
        timeZone = profile?.timezone || IST_TIMEZONE;
    } catch (e) {
        console.warn(`[onGoodNightClosed] profile lookup failed, assuming ${IST_TIMEZONE}: ${e.message}`);
    }

    const logDate = localDateOf(flow.startedAt, timeZone);
    if (!logDate) {
        console.warn(`[onGoodNightClosed] flow ${flow._id} has no usable startedAt — nothing queued`);
        return null;
    }

    // Imported at call time, not at module load. The static chain would be
    // completeFlow -> this -> summarizeDayJob -> agent -> the tool registry ->
    // CompleteFlowTool -> completeFlow, and a cycle through the registry is
    // resolved while it is half-built. Deferring it costs one cache lookup.
    const { scheduleDaySummary } = await import("./summarizeDayJob.js");
    return scheduleDaySummary({ userId: flow.userId, logDate, timeZone });
}
