/**
 * Seed chatSummary with the last seven days, so the RECENTLY block has
 * something to show before the first nightly pass ever runs.
 *
 * Without this the feature is invisible for a week: the block renders empty
 * until the first goodNight closes, and it takes seven more days before there
 * are headlines behind the newest row. This fills that in from history that is
 * already there.
 *
 * WHAT IT ACTUALLY DOES: queues seven triggerJob rows per user. It does not
 * summarise anything itself. Two reasons, and the first is the important one.
 *
 *  - ORDER. state and openThreads carry forward, and each pass reads the
 *    PREVIOUS day's row as its starting point. Run out of order — or in
 *    parallel — and every day starts from nothing, which is the whole value of
 *    the layer gone. The jobs are spaced an hour apart, OLDEST FIRST, so each
 *    day's row exists well before the next day reads it.
 *  - A migration runs at boot, inside the deploy. Seven live LLM calls per user
 *    on the boot path would hold the service down for minutes and take a quota
 *    block with it. Handing them to the scheduler means a failure retries with
 *    backoff instead of failing a deploy.
 *
 * So the migration finishes in milliseconds and the backfill completes about
 * seven hours later. `GET /` reports what was queued; the rows themselves show
 * up in chatSummary as each hour passes.
 *
 * Nothing is deleted and nothing is overwritten. A day that already has a row
 * is skipped, so this is safe to re-run and safe to run alongside the nightly
 * pass.
 */
import { getDB } from "../mongoClient.js";
import { CHAT_HISTORY } from "../schema/chatHistorySchema.js";
import { USERS } from "../schema/usersSchema.js";
import { scheduleDaySummary } from "../../../scheduler/jobs/summarizeDayJob.js";
import { localDateOf, previousDay, localDayRange, IST_TIMEZONE } from "../dateUtils.js";

const MIGRATION = "004-backfill-day-summaries";

// Yesterday and the six days before it — the exact window the RECENTLY block
// renders: one full row plus seven headlines behind it.
const DAYS = 7;

// Between consecutive days for one user. Generous on purpose: a pass takes
// seconds, but a quota block costs three retries with backoff, and the next day
// in the chain must not start until this one's row is written.
const HOUR_MS = 60 * 60 * 1000;

// The first job does not fire the moment the deploy finishes. A boot has
// indexes to build and a Telegram loop to start, and the summarize chain shares
// its per-minute quota with whatever the user is doing right now.
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

// Turns in the window below which a user is not worth backfilling. The users
// table carries accounts created while testing the identity layer, several with
// a single turn to their name; seven requests each, to write seven rows saying
// nothing happened, is the whole cost of this migration spent on noise.
const MIN_TURNS = 3;

/**
 * Users worth backfilling: those with any conversation in the window.
 *
 * Not every row in `users`. Most of them are dormant, and queueing seven jobs
 * for someone with nothing to summarise spends seven requests to write seven
 * rows that say nothing happened.
 */
async function usersWithHistory(db, from, to) {
    const counts = await db.collection(CHAT_HISTORY).aggregate([
        { $match: { createdAt: { $gte: from, $lt: to } } },
        { $group: { _id: "$userId", turns: { $sum: 1 } } },
    ]).toArray();

    const active = counts.filter(c => c.turns >= MIN_TURNS);
    if (!active.length) return { targets: [], rejected: counts };

    const ids = active.map(c => c._id);
    const profiles = await db.collection(USERS).find({ userId: { $in: ids } }).toArray();
    const byId = new Map(profiles.map(p => [p.userId, p]));

    return {
        targets: active.map(c => ({
            userId: c._id,
            turns: c.turns,
            timeZone: byId.get(c._id)?.timezone || IST_TIMEZONE,
        })),
        rejected: counts.filter(c => c.turns < MIN_TURNS),
    };
}

export async function runBackfillDaySummaries({ apply = false } = {}) {
    const db = await getDB();
    const report = {
        apply,
        database: db.databaseName,
        status: "pending",
        days: DAYS,
        users: [],
        queued: 0,
        skipped: 0,
        steps: [],
    };
    const step = (m) => { report.steps.push(m); console.log(`[migration:${MIGRATION}] ${m}`); };

    // Oldest first. The order of this array IS the execution order, and it is
    // the one thing this migration must not get wrong.
    const today = localDateOf(new Date(), IST_TIMEZONE);
    const dates = [];
    let cursor = previousDay(today);
    for (let i = 0; i < DAYS; i++) {
        dates.unshift(cursor);
        cursor = previousDay(cursor);
    }
    step(`window: ${dates[0]} .. ${dates[dates.length - 1]} (oldest first)`);

    const { start } = localDayRange(dates[0]);
    const { end } = localDayRange(dates[dates.length - 1]);
    const { targets, rejected } = await usersWithHistory(db, start, end);

    if (rejected.length) {
        report.tooQuiet = rejected.map(r => ({ userId: r._id, turns: r.turns }));
        step(`skipped ${rejected.length} user(s) under ${MIN_TURNS} turns: ` +
             rejected.map(r => `${r._id}(${r.turns})`).join(", "));
    }

    if (!targets.length) {
        report.status = "nothing-to-do";
        step("no user has enough conversation in the window to be worth backfilling");
        return report;
    }
    step(`${targets.length} user(s) to backfill: ${targets.map(t => `${t.userId}(${t.turns} turns)`).join(", ")}`);

    const firstRun = Date.now() + FIRST_RUN_DELAY_MS;

    for (const { userId, timeZone, turns } of targets) {
        const perUser = { userId, timeZone, turns, queued: [], skipped: [] };

        for (const [index, logDate] of dates.entries()) {
            // Every user's day N fires at the same hour. Days within one user
            // stay an hour apart, which is the ordering that matters; separate
            // users have separate carry-forward chains and do not interleave.
            const runAt = new Date(firstRun + index * HOUR_MS);

            if (!apply) {
                perUser.queued.push({ logDate, runAt: runAt.toISOString() });
                continue;
            }

            // scheduleDaySummary is the same function the nightly path calls,
            // so the "already summarised" and "already queued" guards are the
            // ones already in use rather than a second copy written here.
            const id = await scheduleDaySummary({ userId, logDate, timeZone, runAt });
            if (id) perUser.queued.push({ logDate, runAt: runAt.toISOString(), jobId: String(id) });
            else perUser.skipped.push(logDate);
        }

        report.queued += perUser.queued.length;
        report.skipped += perUser.skipped.length;
        report.users.push(perUser);

        step(`user ${userId}: ${perUser.queued.length} queued, ${perUser.skipped.length} already done`);
    }

    if (!apply) {
        report.status = "dry-run";
        step(`dry run: would queue ${report.queued} job(s)`);
        return report;
    }

    if (!report.queued) {
        report.status = "nothing-to-do";
        step("every day in the window is already summarised");
        return report;
    }

    report.status = "applied";
    report.completesAround = new Date(firstRun + (DAYS - 1) * HOUR_MS).toISOString();
    step(
        `${report.queued} job(s) queued. First fires in ${FIRST_RUN_DELAY_MS / 60000} minutes, ` +
        `last around ${report.completesAround}. Watch chatSummary, or the logs for ` +
        `"[summarizeDayJob] wrote".`
    );

    return report;
}

export default runBackfillDaySummaries;
