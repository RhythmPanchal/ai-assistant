import { ProviderManager } from "../llm/createProvider.js";
import { startTurn } from "../llm/usageMeter.js";
import { extractJson } from "../summarize/summarizeDay.js";
import { coerceScore } from "../summarize/reviewDay.js";
import { TURN_CRITIQUE_INSTRUCTION, buildCritiqueInput } from "./critiquePrompt.js";
import { IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";

/**
 * The nightly audit of the agent's own replies.
 *
 * A direct ProviderManager call, for the same reasons the summary pass is one
 * (§7a): no tools, no chat history, and nothing written by the call itself.
 * Routing it through runAgent would hand a critic the day's conversation as
 * LIVE history and the full tool declarations it must not use — and it would
 * write a chatHistory document, so tomorrow's critic would audit today's
 * critique.
 */

export const KINDS = ["hallucination", "bug", "improvement"];
export const SEVERITIES = ["high", "medium", "low"];

// A day's findings. Past this the report stops being a work list and becomes a
// second transcript; a critic emitting thirteen findings has started padding.
const MAX_FINDINGS = 12;

const SUMMARY_CHARS = 240;
const EVIDENCE_CHARS = 400;
const SUGGESTION_CHARS = 400;

// Shortest quote worth treating as evidence. Below this it is a word, not a
// citation, and it cannot be checked against the transcript.
const MIN_EVIDENCE_CHARS = 10;

const clean = (value, cap) => {
    if (typeof value !== "string") return null;
    const t = value.trim().replace(/\s+/g, " ");
    if (!t || ["null", "none", "n/a"].includes(t.toLowerCase())) return null;
    return t.length <= cap ? t : `${t.slice(0, cap - 1)}…`;
};

const flat = (s) => String(s).replace(/\s+/g, " ").toLowerCase();

/**
 * What we keep from the reply.
 *
 * Three drops, each for an observed failure rather than on principle:
 *
 *  - a finding citing a turn that does not exist. The id is the only handle the
 *    fix session has on the evidence, so an unanchored finding is unactionable
 *    and usually a sign the model lost track of the day.
 *  - a finding with no summary or no evidence. Evidence is the whole defence
 *    against a critic inventing work; a finding that cannot be quoted is one
 *    that cannot be checked.
 *  - an unknown `kind`. The report groups by it and the fix session prioritises
 *    on it, so an invented category would silently sort to the bottom.
 *
 * severity, by contrast, is defaulted rather than dropped: it is a label on a
 * finding, not a fact about the day, and throwing away a well-evidenced
 * hallucination because its severity was spelled "critical" loses the thing we
 * ran the pass for.
 */
export function coerceCritique(parsed, { turnIds = [], transcript = "" } = {}) {
    const known = new Set(turnIds);
    const haystack = flat(transcript);
    const dropped = [];

    const findings = [];
    for (const raw of Array.isArray(parsed?.findings) ? parsed.findings : []) {
        if (!raw || typeof raw !== "object") continue;

        const turn = typeof raw.turn === "string" ? raw.turn.trim() : "";
        const kind = KINDS.includes(raw.kind) ? raw.kind : null;
        const summary = clean(raw.summary, SUMMARY_CHARS);
        const evidence = clean(raw.evidence, EVIDENCE_CHARS);

        if (!known.has(turn)) { dropped.push(`unknown turn "${turn || "(none)"}"`); continue; }
        if (!kind) { dropped.push(`unknown kind "${raw.kind}" on ${turn}`); continue; }
        if (!summary) { dropped.push(`no summary on ${turn}`); continue; }
        if (!evidence || evidence.length < MIN_EVIDENCE_CHARS) { dropped.push(`no usable evidence on ${turn}`); continue; }

        findings.push({
            turn,
            kind,
            severity: SEVERITIES.includes(raw.severity) ? raw.severity : "medium",
            summary,
            evidence,
            suggestion: clean(raw.suggestion, SUGGESTION_CHARS),
            // Whether the quote is really in the transcript, normalised for
            // whitespace and case. NOT a drop: models paraphrase quotes often
            // enough that exact matching would discard sound findings. It is
            // carried into the report so the fix session knows which findings
            // rest on a verbatim citation and which on a recollection.
            quoted: haystack.includes(flat(evidence)),
        });

        if (findings.length >= MAX_FINDINGS) break;
    }

    // Worst first. The report is read top-down by whoever fixes it, and within
    // a severity a wrong claim outranks a missed opportunity.
    const bySeverity = { high: 0, medium: 1, low: 2 };
    const byKind = { hallucination: 0, bug: 1, improvement: 2 };
    findings.sort((a, b) =>
        bySeverity[a.severity] - bySeverity[b.severity] ||
        byKind[a.kind] - byKind[b.kind] ||
        a.turn.localeCompare(b.turn, undefined, { numeric: true })
    );

    const score = coerceScore(parsed?.satisfaction?.score);

    return {
        satisfaction: { score, why: score === null ? null : clean(parsed?.satisfaction?.why, SUMMARY_CHARS) },
        findings,
        wentWell: (Array.isArray(parsed?.wentWell) ? parsed.wentWell : [])
            .map(v => clean(v, SUMMARY_CHARS))
            .filter(Boolean)
            .slice(0, 3),
        dropped,
    };
}

/** The two messages sent. Exported so a dry run can print them without spending a request. */
export function buildCritiqueMessages({ logDate, transcript, turnCount, timeZone = IST_TIMEZONE }) {
    const weekday = new Date(`${logDate}T12:00:00+05:30`)
        .toLocaleDateString("en-GB", { timeZone, weekday: "long" });

    return [
        { role: "system", content: TURN_CRITIQUE_INSTRUCTION },
        { role: "user", content: buildCritiqueInput({ logDate, weekday, turnCount, transcript }) },
    ];
}

/**
 * @returns {Promise<{critique: object, raw: string, provider: string, model: string}>}
 * @throws  when no model can be reached. A reply that arrives but is not usable
 *          JSON throws too — unlike the day review, there is no partial result
 *          worth keeping here, and the report is the entire output.
 */
export async function critiqueDay({ userId, logDate, transcript, turns = [], timeZone = IST_TIMEZONE, apiKeys = {} }) {
    if (!Number.isInteger(userId)) throw new Error("[critiqueDay] userId must be an integer");
    if (!logDate) throw new Error("[critiqueDay] logDate is required");

    const turnIds = turns.map(t => t.id);
    const messages = buildCritiqueMessages({ logDate, transcript, turnCount: turnIds.length, timeZone });
    const meter = startTurn(userId, "critiqueJob", "critique");

    try {
        const manager = new ProviderManager(apiKeys, "critique");
        console.log(`[critiqueDay] ${logDate} for ${userId}: ${turnIds.length} turn(s)`);

        meter.recordStep();
        const response = await manager.chatWithFallback(messages, [], {
            onAttempt: (provider, model) => meter.recordCall(`${provider}:${model}`),
            onResult: (info) => meter.recordResult(info),
        });

        const critique = coerceCritique(extractJson(response.text), { turnIds, transcript });
        if (critique.dropped.length) {
            console.warn(`[critiqueDay] ${logDate}: dropped ${critique.dropped.length} finding(s) — ${critique.dropped.join("; ")}`);
        }

        await meter.finish("ok");
        return { critique, raw: response.text, provider: response.provider, model: response.model };
    } catch (err) {
        meter.recordError(err);
        await meter.finish("error");
        throw err;
    }
}

export const CRITIQUE_CAPS = { MAX_FINDINGS, MIN_EVIDENCE_CHARS };
