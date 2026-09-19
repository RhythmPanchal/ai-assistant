import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";
import { personalDayRange, localDateOf, DAY_START_HOUR, IST_TIMEZONE } from "../tools/mongo/dateUtils.js";


const MAX_HISTORY_TURNS = 50;

// Fallback when the current day has nothing yet. Kept small on purpose: this is
// yesterday's context bleeding into today, useful for continuity ("the thing we
// discussed last night") but wrong to lean on heavily.
const FALLBACK_TURNS = 5;
const FALLBACK_MAX_MESSAGES = 15;

// Usage metadata is written per turn but never read back into a prompt, and
// this runs before every turn over up to 50 documents. Excluded rather than
// merely ignored so it is not pulled across the wire.
const HISTORY_PROJECTION = { llmConversationMetadata: 0 };

/**
 * Converts conversation documents into the provider-neutral shape every
 * LLM provider translates: [{ role: "user" | "assistant", content }].
 *
 * Was Gemini-specific ([{ role, parts }]). Now that runAgent can fall back to
 * Groq/OpenRouter, the history must not be pre-shaped for one vendor —
 * GeminiProvider and OpenAICompatibleProvider each convert it themselves.
 */
function formatChatHistoryForGeneric(conversations) {
    const history = [];

    for (const conv of conversations) {
        for (const msg of conv.messages) {
            if (msg.role === "user") {
                history.push({ role: "user", content: msg.content });
            } else if (msg.role === "assistant") {
                // Text replies only. A tool-call turn is only valid when
                // immediately followed by its tool results, and we drop those
                // to save context — so the matching call must go too, or
                // strict providers reject the whole request.
                if (msg.content) history.push({ role: "assistant", content: msg.content });
            }
            // msg.role === "tool" — skipped, see above.
        }
    }

    return history;
}

/**
 * The turns of the personal day `at` falls in — see personalDayRange. It was
 * setHours(0,0,0,0) on a bare Date, which is the wrong boundary AND the host's
 * zone rather than the user's.
 */
async function fetchDayChatRecords(userId, { timeZone, dayStartHour, at }) {
    if (!userId) {
        console.trace();
        throw new Error("userId is required to fetch chat history");
    }

    const db = await getDB();
    const { start, end } = personalDayRange(at, { hour: dayStartHour, timeZone });

    // Pull the N most recent turns (newest first), then reverse for
    // chronological replay. This avoids loading the entire day's history
    // once the conversation gets long.
    const recent = await db
        .collection(CHAT_HISTORY)
        .find({
            userId: userId,
            createdAt: { $gte: start, $lt: end },
        })
        .project(HISTORY_PROJECTION)
        .sort({ createdAt: -1 })
        .limit(MAX_HISTORY_TURNS)
        .toArray();

    return recent.reverse();
}

/**
 * The most recent turns regardless of day. Used only when today is still empty.
 */
async function fetchRecentChatRecords(userId, limit) {
    const db = await getDB();
    const recent = await db
        .collection(CHAT_HISTORY)
        .find({ userId })
        .project(HISTORY_PROJECTION)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

    return recent.reverse();
}

/**
 * The days the carried-over messages came from: "2026-09-18", or "2026-09-16
 * to 2026-09-18" when they straddle more than one. Newest-first and stopping
 * at `kept` messages, because the caller trims from the front and a day whose
 * messages were all trimmed is not in the history to be discounted.
 */
function daysSpanned(conversations, kept, timeZone) {
    const days = new Set();
    let seen = 0;
    for (let i = conversations.length - 1; i >= 0 && seen < kept; i--) {
        const n = formatChatHistoryForGeneric([conversations[i]]).length;
        if (!n) continue;
        const day = localDateOf(conversations[i].createdAt, timeZone);
        if (day) days.add(day);
        seen += n;
    }
    const sorted = [...days].sort();
    if (!sorted.length) return null;
    return sorted.length === 1 ? sorted[0] : `${sorted[0]} to ${sorted[sorted.length - 1]}`;
}

/**
 * Provider-neutral chat history for ProviderManager, and whether it is today's.
 *
 * History is scoped to the personal day so context resets once a day rather
 * than at midnight — see personalDayRange. But the first message of a day
 * arrives into a completely empty history — on 2026-08-16 the user's 13:34
 * message had nothing behind it but the 09:00 job — so the agent opens cold and
 * cannot refer to anything discussed the day before. When the day has nothing
 * yet, fall back to the last few turns whenever they happened.
 *
 * `carriedFrom` names the day(s) those turns came from, and is null on the
 * normal path. runAgent turns it into a block saying the history is old.
 *
 * @returns {Promise<{ history: object[], carriedFrom: string|null }>}
 */
export default async function chatHistoryKnowledge(userId, { timeZone = IST_TIMEZONE, dayStartHour = DAY_START_HOUR, at = new Date() } = {}) {
    const hour = Number.isInteger(dayStartHour) ? dayStartHour : DAY_START_HOUR;

    let conversations = await fetchDayChatRecords(userId, { timeZone, dayStartHour: hour, at });
    let history = formatChatHistoryForGeneric(conversations);
    if (history.length) return { history, carriedFrom: null };

    conversations = await fetchRecentChatRecords(userId, FALLBACK_TURNS);
    history = formatChatHistoryForGeneric(conversations);
    // Trim from the FRONT so the newest turns survive.
    if (history.length > FALLBACK_MAX_MESSAGES) {
        history = history.slice(-FALLBACK_MAX_MESSAGES);
    }
    // A history that opens on an assistant turn is a dangling reply with no
    // prompt; some providers reject it outright.
    while (history.length && history[0].role !== "user") history.shift();

    if (!history.length) return { history: [], carriedFrom: null };

    const carriedFrom = daysSpanned(conversations, history.length, timeZone);
    console.log(`[chatHistoryKnowledge] day empty — carried ${history.length} messages from ${carriedFrom}`);
    return { history, carriedFrom };
}
