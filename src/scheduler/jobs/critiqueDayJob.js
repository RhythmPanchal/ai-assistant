import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import turnReviewKnowledge from "../../knowledge/turnReviewKnowledge.js";
import { critiqueDay } from "../../agent/critique/critiqueDay.js";
import { verifyWrites, renderVerificationBlock, findingsFromChecks } from "../../agent/critique/verifyWrites.js";
import { renderCritiqueReport } from "../../agent/critique/critiqueReport.js";
import { getUserProfile } from "../../identity/userManager.js";
import {
    IST_TIMEZONE, DAY_START_HOUR, dayScope, personalDayOf, previousDay, localHourOf,
} from "../../tools/mongo/dateUtils.js";

/**
 * Reads back a finished day of the agent's own conversations, grades them, and
 * writes the report into the repo for a human or a coding session to act on.
 *
 * Fires at 03:00 local for users with preferences.agentCritique set. Opt-in
 * because it is an engineering instrument, not a feature of the assistant: it
 * spends a model call per user per day and the person it is about never sees
 * its output.
 */

// Local hour the pass runs. 13:00 rather than the small hours: the machine this
// runs on is asleep at 03:00, so a night-time pass simply never fired. Early
// afternoon is late enough that yesterday is long finished — it ended at
// DAY_START_HOUR — and pickCritiqueDay handles the hour being on either side of
// that boundary.
export const CRITIQUE_HOUR = 13;

// Under the repo root, and gitignored. A generated file per night inside tracked
// paths would leave `git status` dirty every single morning, which collides
// head-on with this project's start-clean rule — so the report is a local
// artifact that a session reads, not history that accumulates in the tree.
const DEFAULT_DIR = "scratch/critique";

const repoRoot = () => path.resolve(new URL("../../../", import.meta.url).pathname);

export function reportDir() {
    const configured = process.env.CRITIQUE_REPORT_DIR || DEFAULT_DIR;
    return path.isAbsolute(configured) ? configured : path.join(repoRoot(), configured);
}

export const reportPath = (userId, logDate) => path.join(reportDir(), `${logDate}-user${userId}.md`);

/**
 * Which day to critique.
 *
 * At 03:00 with a 04:00 day start, the personal day in progress IS yesterday —
 * the night's wrap-up and any 00:40 reply are inside it, and it will not change
 * again. So the day in progress is the right answer, and taking the previous
 * day as well would review a day already reviewed.
 *
 * But the hour is configurable, and a pass moved to 10:00 would then be handed
 * a day with most of itself still to happen. So the test is not the clock hour
 * directly but whether the current personal day has started: before the day
 * boundary the in-progress day is finished, after it the finished one is the
 * day before.
 */
export function pickCritiqueDay(at, { timeZone = IST_TIMEZONE, dayStartHour = DAY_START_HOUR } = {}) {
    const today = personalDayOf(at, { hour: dayStartHour, timeZone });
    return localHourOf(at, timeZone) < dayStartHour ? today : previousDay(today);
}

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Critique one day for one user and write the report.
 *
 * Throws on failure, so a row dispatched through executeTriggerJob gets its
 * retry and backoff. The cron path catches per user, because one user's dead
 * quota must not stop the next user's pass.
 *
 * @param {boolean} [force] rewrite a report that already exists
 */
export async function critiqueDayJob(userId, logDate = null, timeZone = IST_TIMEZONE, force = false) {
    if (!Number.isInteger(userId)) throw new Error("[critiqueDayJob] userId must be an integer");

    let apiKeys = {};
    let dayStartHour = DAY_START_HOUR;
    try {
        const profile = await getUserProfile(userId);
        apiKeys = profile?.apiKeys || {};
        ({ dayStartHour } = dayScope(profile));
        timeZone = profile?.timezone || timeZone;
    } catch (e) {
        console.warn(`[critiqueDayJob] profile lookup failed, using shared keys: ${e.message}`);
    }

    const day = logDate || pickCritiqueDay(new Date(), { timeZone, dayStartHour });
    const file = reportPath(userId, day);

    if (!force && await exists(file)) {
        console.log(`[critiqueDayJob] ${day} already critiqued for ${userId} — skipping`);
        return { skipped: true, reason: "already-written", logDate: day, file };
    }

    const { transcript, turns, turnCount } = await turnReviewKnowledge(userId, day, { timeZone, dayStartHour });
    if (!turnCount) {
        // No report at all rather than an empty one. A night with no
        // conversation is not a finding, and a file saying so would still make
        // the fix session open it.
        console.log(`[critiqueDayJob] ${day} has no turns for ${userId} — nothing to critique`);
        return { skipped: true, reason: "no-turns", logDate: day };
    }

    // Before the model, and independent of it. Every write the day attempted is
    // re-read from the database, so a row that is not there becomes a finding
    // whether or not the critic notices it — and the critic is handed the
    // verdicts so it cannot claim a confirmed row was lost.
    const { checks, counts } = await verifyWrites(turns, { userId });
    const verification = {
        block: renderVerificationBlock(checks),
        summary: checks.length
            ? Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")
            : "no writes attempted",
    };
    const dbFindings = findingsFromChecks(checks);
    if (dbFindings.length) {
        console.warn(`[critiqueDayJob] ${day}: ${dbFindings.length} write(s) did not land — ${verification.summary}`);
    }

    const { critique, provider, model } = await critiqueDay({
        userId, logDate: day, transcript, turns, timeZone, apiKeys,
        verification: verification.block, dbFindings,
    });

    const report = renderCritiqueReport({
        userId, logDate: day, critique, turns, verification,
        model: `${provider}:${model}`, timeZone,
    });

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${report}\n`, "utf8");

    const high = critique.findings.filter(f => f.severity === "high").length;
    console.log(
        `[critiqueDayJob] wrote ${file} via ${provider}:${model} — ` +
        `${critique.findings.length} finding(s), ${high} high, satisfaction ${critique.satisfaction.score ?? "-"}/5`
    );

    return { skipped: false, logDate: day, file, critique, turnCount, checks };
}

/** The cron entry: one opted-in user, their own day and zone. */
export async function critiqueDayFor(user) {
    const timeZone = user.timezone || IST_TIMEZONE;
    const { dayStartHour } = dayScope(user);
    const day = pickCritiqueDay(new Date(), { timeZone, dayStartHour });
    return critiqueDayJob(user.userId, day, timeZone);
}
