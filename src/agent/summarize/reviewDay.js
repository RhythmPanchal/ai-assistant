import { ProviderManager } from "../llm/createProvider.js";
import { startTurn } from "../llm/usageMeter.js";
import { DAY_REVIEW_INSTRUCTION, buildDayReviewInput } from "./reviewPrompt.js";
import { extractJson } from "./summarizeDay.js";
import { OUTCOMES } from "./planComparison.js";
import { IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";

/**
 * The judgement half of a day's review: which logged work filled which planned
 * block, and the 1-5 scores.
 *
 * A direct ProviderManager call like summarizeDay, for the same reasons — no
 * tools, no chat history, nothing written by the call itself. The model returns
 * matches and scores only; everything countable is done by comparePlan over the
 * rows, so a model that cannot add up cannot get a number wrong.
 */

// One line of evidence. Long enough for a reason, short enough that a model
// retelling the day cannot turn a score into a second summary.
const WHY_CHARS = 200;

/**
 * A score the model wrote, or null.
 *
 * Takes the forms models actually send — 4, "4", "4/5", 3.5 — and refuses
 * anything outside 1-5 rather than clamping it. An 8 is almost certainly a
 * score out of ten, and turning it into a 5 would record a guess as a fact.
 */
export function coerceScore(value) {
    let n = NaN;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && /^\s*\d+(\.\d+)?\s*(\/\s*5\s*)?$/.test(value)) n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return null;
    const score = Math.round(n);
    return score >= 1 && score <= 5 ? score : null;
}

function cleanWhy(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text || ["null", "none", "n/a"].includes(text.toLowerCase())) return null;
    return text.length <= WHY_CHARS ? text : `${text.slice(0, WHY_CHARS - 1)}…`;
}

// A why with no score is dropped: it is the evidence for a number that does not
// exist, usually "no information about health".
function coerceRating(rating) {
    const score = coerceScore(rating?.score);
    return { score, why: score === null ? null : cleanWhy(rating?.why) };
}

/**
 * What we keep from the reply. Anything unusable becomes null or is dropped —
 * never a default, since a default score is a made-up score.
 *
 * Match ids are only trimmed here. Whether they name a real block or real work
 * is comparePlan's check, because that is where the lists are.
 */
export function coerceReview(parsed) {
    const matches = (Array.isArray(parsed?.matches) ? parsed.matches : [])
        .filter(m => m && typeof m === "object" && typeof m.block === "string")
        .map(m => ({
            block: m.block.trim(),
            work: (Array.isArray(m.work) ? m.work : []).filter(w => typeof w === "string").map(w => w.trim()),
            outcome: OUTCOMES.includes(m.outcome) ? m.outcome : null,
        }));

    return {
        matches,
        productivity: coerceRating(parsed?.productivity),
        ratings: {
            mood: coerceRating(parsed?.mood),
            health: coerceRating(parsed?.health),
            overall: coerceRating(parsed?.overall),
        },
    };
}

/** The two messages sent. Exported so a dry run can print them without spending a request. */
export function buildReviewMessages({ logDate, transcript, blocks = [], work = [], timeZone = IST_TIMEZONE }) {
    const weekday = new Date(`${logDate}T12:00:00+05:30`)
        .toLocaleDateString("en-GB", { timeZone, weekday: "long" });

    return [
        { role: "system", content: DAY_REVIEW_INSTRUCTION },
        { role: "user", content: buildDayReviewInput({ logDate, weekday, blocks, work, transcript }) },
    ];
}

/**
 * @returns {Promise<{review: object, raw: string, provider: string, model: string}>}
 * @throws  when no model can be reached — the scheduler retries the whole day,
 *          summary included. A reply that arrives but is not usable JSON does
 *          NOT throw: it costs the scores, and the summary is still written.
 */
export async function reviewDay({ userId, logDate, transcript, blocks = [], work = [], timeZone = IST_TIMEZONE, apiKeys = {} }) {
    if (!Number.isInteger(userId)) throw new Error("[reviewDay] userId must be an integer");
    if (!logDate) throw new Error("[reviewDay] logDate is required");

    const messages = buildReviewMessages({ logDate, transcript, blocks, work, timeZone });
    // Metered under the summary job it belongs to, so the job's whole cost is
    // one line in the rollup.
    const meter = startTurn(userId, "summarizeJob", "summarize");

    try {
        const manager = new ProviderManager(apiKeys, "summarize");
        console.log(`[reviewDay] ${logDate} for ${userId}: ${blocks.length} planned block(s), ${work.length} logged`);

        meter.recordStep();
        const response = await manager.chatWithFallback(messages, [], {
            onAttempt: (provider, model) => meter.recordCall(`${provider}:${model}`),
            onResult: (info) => meter.recordResult(info),
        });

        let review;
        try {
            review = coerceReview(extractJson(response.text));
        } catch (err) {
            // Retrying the whole job for this would re-run the summary too, and a
            // model that keeps answering in prose would then lose the day's
            // memory after three attempts. The scores are the cheaper loss.
            console.warn(`[reviewDay] ${logDate}: unusable reply, scores left empty — ${err.message}`);
            review = coerceReview(null);
        }

        await meter.finish("ok");
        return { review, raw: response.text, provider: response.provider, model: response.model };
    } catch (err) {
        meter.recordError(err);
        await meter.finish("error");
        throw err;
    }
}
