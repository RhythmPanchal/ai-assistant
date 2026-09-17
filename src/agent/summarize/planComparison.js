import { ROUTINE_CATEGORY, isRoutineBlock } from "../../tools/mongo/operation/routineBlock.js";

/**
 * A day's plan against the work it logged — the arithmetic half of how
 * productive the day was.
 *
 * The numbers come from rows only: the schedule insertSchedule locked in that
 * morning, and the task log the night routine filled. Nothing here reads the
 * chat, so the same two rows always give the same numbers.
 *
 * The one step code cannot take is deciding which logged work was which planned
 * block. "Q3 deck review" and "went through Ankit's comments on the deck" are the
 * same work, and no string comparison says so. The review pass supplies that
 * mapping (see reviewDay.js); this module validates it — an id that does not
 * exist is ignored — and does every sum. The exception is a slot and a log entry
 * that name the same backlog task: they are certainly the same work, so that
 * link is made here and the model cannot undo it.
 */

export const VERDICTS = Object.freeze({
    NO_PLAN: "no plan",
    NOTHING_LOGGED: "nothing logged",
    FOLLOWED: "followed the plan",
    PARTLY: "partly followed",
    DIFFERENT: "did different work",
    SHORT: "fell short of the plan",
});

/** What the review may say became of a planned block. */
export const OUTCOMES = Object.freeze(["done", "partial", "not done", "unclear"]);

// Most of the plan's minutes were filled by its own work.
const FOLLOWED_PCT = 75;
// Below this, the plan did not happen. Whether that was a lost day or a day of
// other work is what the unplanned share decides.
const FELL_SHORT_PCT = 40;
const MOSTLY_UNPLANNED_PCT = 50;

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesBetween(start, end) {
    if (!HH_MM.test(start ?? "") || !HH_MM.test(end ?? "")) return 0;
    const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const from = toMin(start);
    const to = toMin(end);
    if (from === to) return 0;
    // A block that runs past midnight, "23:30"-"00:30".
    return to > from ? to - from : to + 1440 - from;
}

const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);

/**
 * The blocks worth measuring: the schedule without its furniture. Nobody fails
 * to have lunch, and counting it would pad every day's plan with done minutes.
 *
 * Blocks dropped during the day (Skipped, Rescheduled) stay in. The day is
 * measured against the plan locked in that morning — a block talked out of at
 * noon still did not happen — and the review sees the status to judge why.
 *
 * Ids b1, b2… are what the review refers to; they are shorter and harder to
 * garble than slotIds.
 *
 * @param {object|null} schedule a userSchedule document
 */
export function workBlocksOf(schedule) {
    const slots = Array.isArray(schedule?.slots) ? schedule.slots : [];
    return slots
        .filter(s => s?.title && s.category !== ROUTINE_CATEGORY && !isRoutineBlock(s.title))
        .map(s => ({ slot: s, minutes: minutesBetween(s.startTime, s.endTime) }))
        .filter(x => x.minutes > 0)
        .sort((a, b) => a.slot.startTime.localeCompare(b.slot.startTime))
        .map(({ slot, minutes }, i) => ({
            id: `b${i + 1}`,
            slotId: slot.slotId ?? null,
            title: String(slot.title),
            startTime: slot.startTime,
            endTime: slot.endTime,
            category: slot.category ?? null,
            status: slot.status ?? "Planned",
            taskRef: slot.taskRef ? String(slot.taskRef) : null,
            minutes,
        }));
}

/**
 * Every piece of work logged for the day, across however many task-log
 * documents exist for it. An entry logged as Skipped did not happen, so it
 * carries no minutes.
 *
 * @param {object[]|object|null} taskLogs taskRegister documents for the day
 */
export function workItemsOf(taskLogs) {
    const docs = Array.isArray(taskLogs) ? taskLogs : (taskLogs ? [taskLogs] : []);
    return docs
        .flatMap(d => d?.performedTasks ?? [])
        .filter(t => t?.title)
        .map((t, i) => ({
            id: `w${i + 1}`,
            title: String(t.title),
            status: t.status ?? "Completed",
            minutes: t.status !== "Skipped" && Number.isInteger(t.actualDurationMinutes) && t.actualDurationMinutes > 0
                ? t.actualDurationMinutes
                : 0,
            taskId: t.taskId ? String(t.taskId) : null,
            category: t.category ?? null,
        }));
}

/** Log entries that close the same backlog task a slot was planned for. */
export function exactLinks(blocks, work) {
    const links = new Map();
    for (const w of work) {
        if (!w.taskId) continue;
        const block = blocks.find(b => b.taskRef === w.taskId);
        if (block) links.set(w.id, block.id);
    }
    return links;
}

export function verdictFor({ plannedMinutes, loggedMinutes, followedPct, unplannedPct }) {
    if (!plannedMinutes) return VERDICTS.NO_PLAN;
    if (!loggedMinutes) return VERDICTS.NOTHING_LOGGED;
    if (followedPct >= FOLLOWED_PCT) return VERDICTS.FOLLOWED;
    if (followedPct < FELL_SHORT_PCT) {
        return unplannedPct >= MOSTLY_UNPLANNED_PCT ? VERDICTS.DIFFERENT : VERDICTS.SHORT;
    }
    return VERDICTS.PARTLY;
}

// What the rows alone say became of a block, for when the review gave nothing
// usable — or said "not done" over work the task log linked to it.
function outcomeFromRows(block, loggedMinutes) {
    if (!loggedMinutes) return "unclear";
    return loggedMinutes >= block.minutes * FOLLOWED_PCT / 100 ? "done" : "partial";
}

/**
 * @param {object}   args
 * @param {object[]} args.blocks    from workBlocksOf
 * @param {object[]} args.work      from workItemsOf
 * @param {object[]} [args.matches] the review's [{ block, work: [ids], outcome }]
 * @returns the plan half of chatSummary.productivity
 */
export function comparePlan({ blocks = [], work = [], matches = [] } = {}) {
    const blockIds = new Set(blocks.map(b => b.id));
    const workIds = new Set(work.map(w => w.id));

    const links = exactLinks(blocks, work);
    const outcomes = new Map();

    for (const match of Array.isArray(matches) ? matches : []) {
        if (!blockIds.has(match?.block)) continue;
        if (OUTCOMES.includes(match.outcome) && !outcomes.has(match.block)) {
            outcomes.set(match.block, match.outcome);
        }
        for (const id of Array.isArray(match.work) ? match.work : []) {
            // One piece of work fills one block. The first claim on it stands,
            // and a shared backlog task outranks any claim.
            if (workIds.has(id) && !links.has(id)) links.set(id, match.block);
        }
    }

    const rows = blocks.map(block => {
        const linked = work.filter(w => links.get(w.id) === block.id);
        const loggedMinutes = sum(linked, "minutes");
        const said = outcomes.get(block.id);
        const contradicted = loggedMinutes > 0 && (said === "not done" || said === "unclear");
        return {
            slotId: block.slotId,
            title: block.title,
            startTime: block.startTime,
            endTime: block.endTime,
            status: block.status,
            minutes: block.minutes,
            loggedMinutes,
            followedMinutes: Math.min(block.minutes, loggedMinutes),
            outcome: said && !contradicted ? said : outcomeFromRows(block, loggedMinutes),
            work: linked.map(w => w.title),
        };
    });

    const unplanned = work.filter(w => !links.has(w.id) && w.minutes > 0);

    const plannedMinutes = sum(rows, "minutes");
    const followedMinutes = sum(rows, "followedMinutes");
    const loggedMinutes = sum(work, "minutes");
    const unplannedMinutes = sum(unplanned, "minutes");
    const followedPct = plannedMinutes ? Math.round(100 * followedMinutes / plannedMinutes) : null;
    const unplannedPct = loggedMinutes ? Math.round(100 * unplannedMinutes / loggedMinutes) : null;

    return {
        verdict: verdictFor({ plannedMinutes, loggedMinutes, followedPct, unplannedPct }),
        plannedMinutes,
        followedMinutes,
        loggedMinutes,
        unplannedMinutes,
        followedPct,
        unplannedPct,
        blocks: rows.map(({ followedMinutes: _, ...row }) => row),
        unplanned: unplanned.map(w => ({ title: w.title, minutes: w.minutes })),
    };
}

/** 150 -> "2h 30m", 60 -> "1h", 45 -> "45m". */
export function formatMinutes(total) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (!h) return `${m}m`;
    return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The comparison as the summary pass reads it, so followThrough is written from
 * the rows rather than guessed from the chat.
 *
 * @param {object} productivity chatSummary.productivity (or comparePlan's result)
 * @returns {string}
 */
export function describeComparison(productivity) {
    const p = productivity;
    if (!p) return "";

    const out = [];
    if (p.verdict === VERDICTS.NO_PLAN) {
        out.push("  No schedule was locked in for this day.");
    } else {
        const followed = `${formatMinutes(p.followedMinutes)} of the ${formatMinutes(p.plannedMinutes)} planned was done (${p.followedPct}%)`;
        out.push(`  Verdict: ${p.verdict} — ${followed}.`);
        for (const b of p.blocks) {
            const done = b.work.length ? ` — logged: ${b.work.join(", ")} (${formatMinutes(b.loggedMinutes)})` : "";
            const dropped = b.status === "Skipped" || b.status === "Rescheduled" ? ` [${b.status.toLowerCase()} during the day]` : "";
            out.push(`  ${b.startTime}-${b.endTime}  ${b.title}: ${b.outcome}${done}${dropped}`);
        }
    }

    if (p.loggedMinutes) {
        out.push(p.unplanned.length
            ? `  Not on the plan: ${p.unplanned.map(u => `${u.title} (${formatMinutes(u.minutes)})`).join(", ")}.`
            : "  All logged work was on the plan.");
    } else {
        out.push("  No work was logged.");
    }
    return out.join("\n");
}
