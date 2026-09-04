import { getDB } from "../mongoClient.js";
import { CHAT_SUMMARY } from "../schema/chatSummarySchema.js";
import { localDayRange } from "../dateUtils.js";

/**
 * Reads for the chatSummary store.
 *
 * Reads only. The write goes through createRecord from inside the summarize
 * overlay, so it picks up normalizeDates, ValidateSchema and the owner stamp
 * like every other model-authored row — this module deliberately offers no way
 * around that.
 */

/**
 * The row covering one local day, or null.
 *
 * Matched on a day RANGE rather than an equality against a constructed Date.
 * The stored value is midnight IST, and an equality match is only correct while
 * every writer anchors identically — a range stays correct if one ever does not.
 *
 * @param {number} userId
 * @param {string} date "YYYY-MM-DD"
 */
export async function findDaySummary(userId, date) {
    if (!date) return null;
    const { start, end } = localDayRange(date);
    const db = await getDB();
    return db.collection(CHAT_SUMMARY).findOne({
        userId,
        period: "day",
        date: { $gte: start, $lt: end },
    });
}

/**
 * Whether a day has already been summarised.
 *
 * The cheap half of the write guard. The expensive half — and the one that
 * actually holds — is the unique index, because this is a read and the write
 * happens minutes later inside an agent turn.
 */
export async function hasDaySummary(userId, date) {
    return Boolean(await findDaySummary(userId, date));
}

/**
 * The most recent day rows STRICTLY BEFORE `before`, newest first.
 *
 * Strictly before, because the day in progress is already in the prompt as raw
 * chat — it has not been summarised yet and will not be until its wrap-up ends.
 * Including it would be impossible; excluding it explicitly is what stops an
 * off-by-one from rendering today twice.
 *
 * The (userId, period, date) index serves this as a prefix plus its own sort,
 * so the limit stops after reading exactly as many entries as it needs.
 *
 * @param {number} userId
 * @param {string} before "YYYY-MM-DD" — exclusive upper bound, normally today
 * @param {number} limit  how many rows back to read
 */
export async function findRecentDaySummaries(userId, before, limit) {
    if (!before || limit <= 0) return [];
    const { start } = localDayRange(before);
    const db = await getDB();
    return db.collection(CHAT_SUMMARY)
        .find({ userId, period: "day", date: { $lt: start } })
        .sort({ date: -1 })
        .limit(limit)
        .toArray();
}
