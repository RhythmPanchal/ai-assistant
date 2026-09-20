import { getDB } from "../mongoClient.js";
import { LLM_TRACE } from "../schema/llmTraceSchema.js";

/**
 * The only place a trace is written or read.
 *
 * Deliberately one module: tracing belongs in a real tracing backend the day
 * this outgrows a collection, and when that day comes this file is the whole
 * of what gets repointed. Nothing else in the codebase knows llmTrace exists.
 */

/**
 * A raw provider response is mostly the text we already keep, but it can also
 * carry a long candidate list or an echoed prompt. Clipped rather than
 * dropped: the finish reason and safety verdicts live at the top of it, and
 * those are the parts worth having.
 */
const MAX_RAW_CHARS = 20000;

/** A system instruction runs 8-40 KB. Past that something has gone wrong; keep the head. */
const MAX_SYSTEM_CHARS = 120000;

function clip(value, limit) {
    if (value === null || value === undefined) return null;

    let text;
    if (typeof value === "string") {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            return "[unserialisable]";
        }
    }

    return text.length <= limit ? text : `${text.slice(0, limit)}… [clipped ${text.length - limit} chars]`;
}

/** Whether this user's turns should be traced. Off unless explicitly turned on. */
export function tracingEnabled(profile) {
    return profile?.preferences?.llmTrace === true;
}

/**
 * Accumulates one turn's trace in memory, then writes it once.
 *
 * Mirrors ConversationBuilder on purpose — a turn is one document, written at
 * the end, so a turn that dies halfway leaves nothing rather than a fragment
 * that reads as a complete record.
 */
export class TraceBuilder {
    constructor({ conversationId, userId, task = null, source = null }) {
        this.conversationId = conversationId;
        this.userId = userId;
        this.task = task;
        this.source = source;
        this.systemInstruction = null;
        this.steps = [];
    }

    /** Called once the system message is final for this turn. */
    setSystemInstruction(text) {
        this.systemInstruction = clip(text, MAX_SYSTEM_CHARS);
        return this;
    }

    /** Open a step. Every attempt recorded after this belongs to it. */
    startStep(step, toolsOffered = []) {
        this.steps.push({ step, toolsOffered: toolsOffered.map(t => t.name ?? String(t)), attempts: [] });
        return this;
    }

    /**
     * One request that actually went out — failures included, because a step
     * that took nine seconds spent most of it on the ones that failed.
     */
    addAttempt({ provider, model, ok, latencyMs, errorKind = null, errorMessage = null, response = null }) {
        const step = this.steps[this.steps.length - 1];
        if (!step) return this;

        step.attempts.push({
            provider,
            model,
            ok: Boolean(ok),
            latencyMs: Math.round(latencyMs ?? 0),
            errorKind,
            errorMessage: errorMessage ? String(errorMessage).slice(0, 1000) : null,
            finishReason: response?.rawResponse?.candidates?.[0]?.finishReason
                ?? response?.rawResponse?.choices?.[0]?.finish_reason
                ?? null,
            rawResponse: clip(response?.rawResponse ?? null, MAX_RAW_CHARS),
        });
        return this;
    }

    build() {
        return {
            conversationId: this.conversationId,
            userId: this.userId,
            task: this.task,
            source: this.source,
            systemInstruction: this.systemInstruction,
            steps: this.steps,
            createdAt: new Date(),
        };
    }
}

/**
 * Persist a turn's trace. NEVER throws — a debugging aid must not be able to
 * fail the turn it is describing.
 */
export async function saveTrace(builder) {
    try {
        const db = await getDB();
        await db.collection(LLM_TRACE).insertOne(builder.build());
    } catch (err) {
        console.warn("[llmTrace] not saved:", err.message);
    }
}

/** One turn's trace, or null. */
export async function getTrace(conversationId) {
    const db = await getDB();
    return db.collection(LLM_TRACE).findOne({ conversationId });
}
