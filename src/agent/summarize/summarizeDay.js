import { ProviderManager, resolveTaskChain } from "../llm/createProvider.js";
import { startTurn } from "../llm/usageMeter.js";
import { DAY_SUMMARY_INSTRUCTION, buildDaySummaryInput } from "./dayPrompt.js";
import { toIST, IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";

/**
 * Turn one day's transcript into a chatSummary row.
 *
 * Deliberately NOT a runAgent turn. Four things would have to be switched off
 * to make runAgent fit — its chat history, its 20 tool declarations, its
 * chatHistory write, and most of its system prompt — and with all four off it
 * is exactly the call below. Worse, each switch is a new way for a real user's
 * turn to go wrong, on the hottest path in the system.
 *
 * The chat history is the one that is not merely wasteful. runAgent injects
 * today's turns and, when today is empty, falls back to the last few turns from
 * ANY day. A pass running at 00:10 on the 4th to summarise the 3rd would be
 * handed the tail of the 3rd as live conversation — the same content the
 * transcript already carries, in a position that says "you were just saying
 * this" rather than "describe this".
 *
 * The model returns content fields only. userId, period and date are set here
 * from arguments the model never sees, which removes the whole class of bugs
 * where it files a row under the wrong day or the wrong person.
 */

const CAPS = { state: 6, openThreads: 6, mentioned: 5 };

// A summary that says nothing is not worth a row. The pass is instructed to
// return one even for an empty day, but "" or "null" is a failed generation
// rather than a quiet day, and the scheduler should retry it.
const MIN_HEADLINE_CHARS = 10;

/**
 * Pull a JSON object out of a model reply.
 *
 * Tolerant on purpose. The chain for this task leads on the highest-volume
 * models rather than the most obedient, and they variously wrap the object in
 * ```json fences, preface it with "Here is the summary:", or add a closing
 * remark. Slicing from the first brace to the last is what survives all three.
 */
export function extractJson(text) {
    if (!text || typeof text !== "string") throw new Error("model returned no text");

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;

    const open = body.indexOf("{");
    const close = body.lastIndexOf("}");
    if (open === -1 || close <= open) {
        throw new Error(`no JSON object in the reply: ${text.slice(0, 200)}`);
    }

    try {
        return JSON.parse(body.slice(open, close + 1));
    } catch (e) {
        throw new Error(`reply was not valid JSON (${e.message}): ${body.slice(open, open + 200)}`);
    }
}

const cleanList = (value, cap) =>
    (Array.isArray(value) ? value : [])
        .filter(v => typeof v === "string" && v.trim())
        .map(v => v.trim())
        .slice(0, cap);

const cleanText = (value) => {
    if (typeof value !== "string") return null;
    const t = value.trim();
    // Models write the string "null" about as often as they emit real null.
    return t && t.toLowerCase() !== "null" && t.toLowerCase() !== "none" ? t : null;
};

/**
 * Build the row we actually store.
 *
 * The caps are re-applied here rather than trusted from the prompt. A prompt is
 * guidance; this is the thing that stops one over-eager generation growing every
 * future prompt by a dozen lines.
 */
export function coerceRow(parsed, { userId, logDate }) {
    const headline = cleanText(parsed?.headline);
    if (!headline || headline.length < MIN_HEADLINE_CHARS) {
        throw new Error(`model returned no usable headline: ${JSON.stringify(parsed?.headline)}`);
    }

    return {
        userId,
        period: "day",
        // From the argument, never from the model. The pass runs after the day
        // it covers — often after midnight — so a model asked to date its own
        // output has a live clock telling it the wrong answer.
        date: toIST(logDate),
        headline,
        state: cleanList(parsed?.state, CAPS.state),
        openThreads: cleanList(parsed?.openThreads, CAPS.openThreads),
        mentioned: cleanList(parsed?.mentioned, CAPS.mentioned),
        followThrough: cleanText(parsed?.followThrough),
        mood: cleanText(parsed?.mood),
    };
}

/** The two messages sent. Exported so a dry run can print them without spending a request. */
export function buildMessages({ logDate, transcript, previous = null, timeZone = IST_TIMEZONE }) {
    const weekday = new Date(`${logDate}T12:00:00+05:30`)
        .toLocaleDateString("en-GB", { timeZone, weekday: "long" });

    return [
        { role: "system", content: DAY_SUMMARY_INSTRUCTION },
        {
            role: "user",
            content: buildDaySummaryInput({
                logDate,
                weekday,
                transcript,
                previous: previous && {
                    dateLabel: new Date(previous.date).toLocaleDateString("en-GB", {
                        timeZone, weekday: "short", day: "2-digit", month: "short",
                    }),
                    state: previous.state,
                    openThreads: previous.openThreads,
                },
            }),
        },
    ];
}

/**
 * @returns {Promise<{row: object, raw: string, provider: string, model: string}>}
 * @throws  when the model cannot be reached or returns nothing usable. Thrown
 *          rather than swallowed so the scheduler's retry and backoff apply —
 *          a day lost to a quota block should be tried again, not written badly.
 */
export async function summarizeDay({ userId, logDate, transcript, previous = null, timeZone = IST_TIMEZONE, apiKeys = {} }) {
    if (!Number.isInteger(userId)) throw new Error("[summarizeDay] userId must be an integer");
    if (!logDate) throw new Error("[summarizeDay] logDate is required");

    const messages = buildMessages({ logDate, transcript, previous, timeZone });
    const meter = startTurn(userId, "summarizeJob");

    try {
        const manager = new ProviderManager(apiKeys, "summarize");
        const chain = resolveTaskChain("summarize").map(e => `${e.provider}:${e.model}`).join(" -> ");
        console.log(`[summarizeDay] ${logDate} for ${userId}\n  chain: ${chain}`);

        // No tools. This pass has nothing to call: the transcript is already in
        // the message, and the row it produces is written by the caller.
        const response = await manager.chatWithFallback(messages, [], {
            onAttempt: (provider, model) => meter.recordCall(`${provider}:${model}`),
        });

        const row = coerceRow(extractJson(response.text), { userId, logDate });
        await meter.finish("ok");

        return { row, raw: response.text, provider: response.provider, model: response.model };
    } catch (err) {
        meter.recordError(err);
        await meter.finish("error");
        throw err;
    }
}
