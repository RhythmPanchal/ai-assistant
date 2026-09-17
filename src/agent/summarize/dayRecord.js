import { summarizeDay } from "./summarizeDay.js";
import { reviewDay } from "./reviewDay.js";
import { workBlocksOf, workItemsOf, comparePlan } from "./planComparison.js";
import { IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";

/**
 * One day's whole chatSummary row: the memory and the scorecard.
 *
 *   1. review    — which logged work filled which planned block, and the scores
 *   2. compare   — code does every sum over the rows, using those matches
 *   3. summarize — the memory pass, handed the comparison for followThrough
 *
 * The review runs first so the summary never has to guess whether the plan
 * happened. Either call failing to reach a model throws, and the job retries the
 * whole day — nothing is written until both have answered.
 *
 * Kept out of the job so the eval runs exactly this composition over fixture
 * days, with no database.
 *
 * @param {object}        args
 * @param {object|null}   args.schedule  the day's userSchedule document
 * @param {object[]}      args.taskLogs  the day's taskRegister documents
 * @returns {Promise<{row: object, review: object, models: {review: string, summary: string}}>}
 */
export async function buildDayRecord({
    userId, logDate, transcript, previous = null, schedule = null, taskLogs = [],
    timeZone = IST_TIMEZONE, apiKeys = {},
}) {
    const blocks = workBlocksOf(schedule);
    const work = workItemsOf(taskLogs);

    const reviewed = await reviewDay({ userId, logDate, transcript, blocks, work, timeZone, apiKeys });
    const { review } = reviewed;

    const productivity = {
        score: review.productivity.score,
        why: review.productivity.why,
        ...comparePlan({ blocks, work, matches: review.matches }),
    };

    const summarized = await summarizeDay({ userId, logDate, transcript, previous, timeZone, apiKeys, productivity });

    return {
        row: { ...summarized.row, productivity, ratings: review.ratings },
        review,
        models: {
            review: `${reviewed.provider}:${reviewed.model}`,
            summary: `${summarized.provider}:${summarized.model}`,
        },
    };
}
