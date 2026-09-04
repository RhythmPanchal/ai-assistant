import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";
import { localDayRange, IST_TIMEZONE } from "../tools/mongo/dateUtils.js";

/**
 * One local day's conversation, rendered as a transcript for the summarizer.
 *
 * This is NOT chatHistoryKnowledge. That one produces provider-neutral message
 * objects to replay as an actual conversation; this produces flat text to be
 * read ABOUT. A summarizer given real history would continue the conversation
 * rather than describe it.
 */

// Per message. The morning routine's schedule draft runs 5-7K characters on its
// own — in prod, days with only two messages still carry 7K, and it is almost
// all one generated assistant turn. The slot list matters (it is what
// followThrough is measured against) so this is generous rather than tight, but
// unbounded it would be most of the summarizer's input.
const MAX_MESSAGE_CHARS = 2000;

// Whole transcript. A heavy day is ~9K characters of real conversation, so this
// is roughly 2.5x the worst day observed — a ceiling, not a working limit.
const MAX_TRANSCRIPT_CHARS = 24000;

function clip(text, limit) {
    const t = String(text).trim();
    return t.length <= limit ? t : `${t.slice(0, limit)}… [truncated]`;
}

/**
 * @param {number} userId
 * @param {string} date "YYYY-MM-DD" — the local day to render
 * @returns {Promise<string>} the transcript, or a plain sentence saying there is none
 */
export default async function dayTranscriptKnowledge(userId, date, { timeZone = IST_TIMEZONE } = {}) {
    if (!userId) throw new Error("[dayTranscriptKnowledge] userId is required");
    if (!date) throw new Error("[dayTranscriptKnowledge] date is required");

    const { start, end } = localDayRange(date);
    const db = await getDB();

    const turns = await db.collection(CHAT_HISTORY)
        .find({
            userId,
            createdAt: { $gte: start, $lt: end },
            // Keep the summarize pass out of its own input. $ne matches documents
            // where the field is absent, which is every row written before source
            // existed — so this excludes exactly the summarize turns and nothing
            // else. (Unlike a range operator, which type-brackets and would drop
            // every row missing the field.)
            source: { $ne: "summarizeJob" },
        })
        .sort({ createdAt: 1 })
        .toArray();

    const lines = [];
    let budget = MAX_TRANSCRIPT_CHARS;

    for (const turn of turns) {
        for (const msg of turn.messages ?? []) {
            // Tool calls and their results are dropped. What a tool returned is
            // already a row in the collection it was written to — re-summarising
            // it here would double-count the day and spend the whole budget on
            // JSON. What the user SAID about it is the part with no other home.
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            if (!msg.content) continue;

            const time = new Date(msg.timestamp ?? turn.createdAt)
                .toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
            const who = msg.role === "user" ? "user" : "rasmalai";
            const line = `[${time}] ${who}: ${clip(msg.content, MAX_MESSAGE_CHARS)}`;

            if (line.length > budget) {
                lines.push("… [earlier messages omitted — transcript too long]");
                budget = 0;
                break;
            }
            budget -= line.length;
            lines.push(line);
        }
        if (budget === 0) break;
    }

    if (!lines.length) return "(no conversation was recorded on this day)";
    return lines.join("\n");
}
