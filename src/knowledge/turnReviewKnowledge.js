import { getDB } from "../tools/mongo/mongoClient.js";
import { CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";
import { personalDayRangeOf, DAY_START_HOUR, IST_TIMEZONE, datesForModel } from "../tools/mongo/dateUtils.js";

/**
 * One personal day's turns, rendered for a critic rather than a summarizer.
 *
 * This is the third day-scoped reader and the only one that keeps tool calls
 * and their results. That is the whole point: a hallucination is a gap between
 * what the agent SAID and what a tool actually returned, so a renderer that
 * drops either side of the comparison cannot support the judgement.
 *
 *   chatHistoryKnowledge  — provider messages, to replay as conversation
 *   dayTranscriptKnowledge — flat prose, tools stripped, to summarise ABOUT
 *   this one               — prose + calls + results, to audit
 *
 * Turns are numbered T1..Tn and the ids are returned alongside the text, so a
 * finding can cite a turn and code can check the citation names a real one.
 */

// Per reply. The morning draft alone runs 5-7K characters, and the critic has
// to read it in full to tell a sound plan from an invented one.
const MAX_MESSAGE_CHARS = 1500;

// Per tool result. Enough to see the shape and the values a reply might have
// come from; not enough for one fetchRecord page to crowd out the day.
const MAX_RESULT_CHARS = 600;

// Whole transcript. Larger than the summarizer's 24K because the tool traffic
// is most of the evidence. Still one call a day, with nobody waiting.
const MAX_TRANSCRIPT_CHARS = 40000;

// A day with more turns than this is not a day the critic can hold in one
// pass. The newest are kept: an old turn has already been reviewed once.
const MAX_TURNS = 40;

// Same map as dayTranscriptKnowledge, and for the same reason: in a job-sourced
// turn the "user" message is the job's own trigger, not the person. The
// summarizer drops those lines; the critic needs them, because "was this reply
// appropriate" is unanswerable without knowing what prompted it.
const SOURCE_LABELS = {
    goodMorningJob: "morning routine",
    goodNightJob: "night routine",
    userOnboardingJob: "onboarding",
    summarizeJob: "day summary",
};

function clip(text, limit) {
    const t = String(text).trim();
    return t.length <= limit ? t : `${t.slice(0, limit)}… [truncated]`;
}

/**
 * A tool result as the model saw it.
 *
 * Through datesForModel first. Without it every Date serialises as UTC and an
 * IST-midnight row reads as the previous day — the critic would then flag a
 * correctly dated expense as the agent writing to the wrong day, which is the
 * exact confusion datesForModel exists to prevent on the live path.
 */
function renderResult(result, timeZone) {
    if (result === null || result === undefined) return "(no result)";
    if (typeof result === "string") return clip(result, MAX_RESULT_CHARS);
    try {
        return clip(JSON.stringify(datesForModel(result, { timeZone })), MAX_RESULT_CHARS);
    } catch {
        return "(unserialisable result)";
    }
}

function renderArgs(args) {
    if (!args || typeof args !== "object") return "{}";
    try {
        return clip(JSON.stringify(args), MAX_RESULT_CHARS);
    } catch {
        return "{…}";
    }
}

/**
 * @param {number} userId
 * @param {string} date "YYYY-MM-DD" — the personal day to render
 * @returns {Promise<{transcript: string, turns: Array<{id,conversationId,source,at}>, turnCount: number}>}
 */
export default async function turnReviewKnowledge(userId, date, { timeZone = IST_TIMEZONE, dayStartHour = DAY_START_HOUR } = {}) {
    if (!Number.isInteger(userId)) throw new Error("[turnReviewKnowledge] userId must be an integer");
    if (!date) throw new Error("[turnReviewKnowledge] date is required");

    const range = personalDayRangeOf(date, { hour: dayStartHour, timeZone });
    if (!range) throw new Error(`[turnReviewKnowledge] "${date}" is not a YYYY-MM-DD date`);

    const db = await getDB();
    const docs = await db.collection(CHAT_HISTORY)
        .find({ userId, createdAt: { $gte: range.start, $lt: range.end } })
        .sort({ createdAt: -1 })
        .limit(MAX_TURNS)
        .toArray();

    return renderTurns(docs.reverse(), { timeZone });
}

/**
 * The pure half: documents in, transcript out. Exported so the guards can
 * exercise the rendering without a database.
 */
export function renderTurns(docs, { timeZone = IST_TIMEZONE } = {}) {
    const turns = [];
    const blocks = [];
    let budget = MAX_TRANSCRIPT_CHARS;
    let truncated = false;

    for (const [i, doc] of docs.entries()) {
        const id = `T${i + 1}`;
        const at = new Date(doc.createdAt ?? Date.now());
        const time = at.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
        const source = doc.source || "telegram";
        const label = SOURCE_LABELS[source] || source;
        const models = doc.llmConversationMetadata?.models?.join(", ");

        const head = `### ${id}  ${time} · ${label}${models ? ` · ${models}` : ""}`;
        const lines = [head];

        for (const msg of doc.messages ?? []) {
            if (msg.role === "user") {
                // A job trigger is not something the person said, and a critic
                // that mistakes one for a user message reads the system's own
                // instruction as a request and grades the reply against it.
                const who = SOURCE_LABELS[doc.source] ? "trigger" : "user";
                if (msg.content) lines.push(`${who}: ${clip(msg.content, MAX_MESSAGE_CHARS)}`);
                continue;
            }
            if (msg.role === "assistant") {
                if (Array.isArray(msg.functionCalls) && msg.functionCalls.length) {
                    for (const call of msg.functionCalls) {
                        lines.push(`rasmalai -> ${call.name}(${renderArgs(call.args)})`);
                    }
                }
                if (msg.content) lines.push(`rasmalai: ${clip(msg.content, MAX_MESSAGE_CHARS)}`);
                continue;
            }
            if (msg.role === "tool") {
                lines.push(`   ${msg.toolName || "tool"} returned: ${renderResult(msg.result, timeZone)}`);
            }
        }

        const block = lines.join("\n");
        if (block.length > budget) {
            truncated = true;
            break;
        }
        budget -= block.length;
        blocks.push(block);
        turns.push({ id, conversationId: doc.conversationId ?? null, source, at });
    }

    if (!blocks.length) {
        return { transcript: "(no conversation was recorded on this day)", turns: [], turnCount: 0 };
    }

    const transcript = truncated
        ? `${blocks.join("\n\n")}\n\n… [later turns omitted — transcript too long]`
        : blocks.join("\n\n");

    return { transcript, turns, turnCount: turns.length };
}

export const CRITIQUE_LIMITS = { MAX_MESSAGE_CHARS, MAX_RESULT_CHARS, MAX_TRANSCRIPT_CHARS, MAX_TURNS };
