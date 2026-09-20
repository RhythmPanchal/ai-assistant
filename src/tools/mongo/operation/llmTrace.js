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

/** Per message in a captured request. Long enough for a real reply, short of a runaway one. */
const MAX_MESSAGE_CHARS = 8000;

/** The whole declaration list is ~24 KB for 23 tools. Twice that is already wrong. */
const MAX_TOOLS_CHARS = 200000;

/**
 * Noise dropped on the way in rather than on the way out, because it is noise
 * in storage too: the SDK's echo of the HTTP response headers was 35% of every
 * captured response, and a thoughtSignature is 128 bytes of opaque base64 that
 * exists only so a call can be replayed to Gemini. Neither says anything about
 * why a model answered the way it did.
 */
function slimResponse(raw) {
    if (!raw || typeof raw !== "object") return raw ?? null;

    const { sdkHttpResponse, ...rest } = raw;

    if (Array.isArray(rest.candidates)) {
        rest.candidates = rest.candidates.map((candidate) => {
            const parts = candidate?.content?.parts;
            if (!Array.isArray(parts)) return candidate;
            return {
                ...candidate,
                content: {
                    ...candidate.content,
                    parts: parts.map(({ thoughtSignature, ...part }) => part),
                },
            };
        });
    }

    return rest;
}

/**
 * One message as it went into a request. Kept structurally rather than as a
 * blob so the console can fold the injected history away from the turn's own
 * exchange — the two look identical in a flat dump and mean quite different
 * things.
 */
function slimMessage(message) {
    const content = clipObject(message?.content ?? null, MAX_MESSAGE_CHARS);

    return {
        role: message?.role ?? "unknown",
        content,
        toolName: message?.toolName ?? null,
        toolCalls: Array.isArray(message?.toolCalls)
            ? message.toolCalls.map((call) => ({ name: call.name, args: call.args ?? {} }))
            : null,
    };
}

/**
 * Like clip, but keeps an object as an object when it fits. A JSON blob that
 * arrives at the console already flattened to a string cannot be rendered as
 * anything but a wall of text, which is the thing this view exists to avoid.
 */
function clipObject(value, limit) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return clip(value, limit);

    let text;
    try {
        text = JSON.stringify(value);
    } catch {
        return "[unserialisable]";
    }

    return text.length <= limit ? value : `${text.slice(0, limit)}… [clipped ${text.length - limit} chars]`;
}

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
        this.prompt = null;
        this.skills = [];
        // How many of step 1's messages are replayed context rather than this
        // turn's own exchange. The console folds them away behind one line.
        this.historyCount = 0;
        this.sentCount = 0;
        // The tool declarations as the model actually received them, recorded
        // when they first apply and again only when they change. They are ~24
        // KB and identical at every step until a skill widens them, so one
        // entry per step would be the same 24 KB written out per step.
        this.toolSets = [];
        this.steps = [];
    }

    /**
     * The parts of the system message that change, kept apart.
     *
     * The persona, hard rules and output contract are the same every turn for
     * everyone and are in the source, so storing them is 6 KB a turn of a
     * constant. What varies is the overlay a flow contributes, the profile
     * block and RECENTLY — and those are what a reply is usually wrong
     * because of. `baseChars` is kept as a sanity check that the assembled
     * prompt was the size it should have been.
     */
    setPrompt({ overlays = [], profile = null, recent = null, carriedFrom = null, baseChars = null } = {}) {
        this.prompt = {
            overlays: overlays.map(o => ({
                kind: o.kind ?? "flow",
                flowType: o.flowType ?? null,
                text: clip(o.text, MAX_SYSTEM_CHARS),
            })),
            profile: clip(profile, MAX_SYSTEM_CHARS),
            recent: clip(recent, MAX_SYSTEM_CHARS),
            carriedFrom,
            baseChars,
        };
        return this;
    }

    /**
     * Open a step, recording what this request adds to the last one.
     *
     * Only the DELTA: the array grows by a few messages per step while the
     * first 20-odd stay identical, so storing it whole each time would be the
     * same prompt written out as many times as the turn has steps. Step 1's
     * delta is the whole request bar the system message, which is held once on
     * the turn.
     */
    startStep(step, toolsOffered = [], messages = []) {
        const sent = messages.slice(Math.max(this.sentCount, 1));
        this.sentCount = messages.length;

        const names = toolsOffered.map(t => t.name ?? String(t));

        // Recorded on the first step, and afterwards only when the set changes
        // — which is exactly when a skill has loaded and widened it. Compared
        // by name: a declaration's schema cannot change without a deploy, and
        // between deploys the names are what moves.
        const last = this.toolSets[this.toolSets.length - 1];
        if (!last || last.names.join("\u0000") !== names.join("\u0000")) {
            this.toolSets.push({
                fromStep: step,
                names,
                declarations: clipObject(toolsOffered, MAX_TOOLS_CHARS),
            });
        }

        this.steps.push({
            step,
            toolsOffered: names,
            request: sent.map(slimMessage),
            attempts: [],
        });
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
            rawResponse: clipObject(slimResponse(response?.rawResponse ?? null), MAX_RAW_CHARS),
        });
        return this;
    }

    build() {
        return {
            conversationId: this.conversationId,
            userId: this.userId,
            task: this.task,
            source: this.source,
            prompt: this.prompt,
            skills: this.skills,
            toolSets: this.toolSets,
            historyCount: this.historyCount,
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
