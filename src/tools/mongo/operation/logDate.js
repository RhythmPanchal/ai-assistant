import { getDB } from "../mongoClient.js";
import { ACTIVE_FLOWS } from "../schema/activeFlowsSchema.js";
import { USERS } from "../schema/usersSchema.js";
import { localDateOf, IST_TIMEZONE } from "../dateUtils.js";

/**
 * Which day a day-log write belongs to.
 *
 * One rule: never later than the day being logged. That day is the open night
 * routine's LOG DATE when there is one, and the user's today when there is not.
 *
 * The rule is shaped by the one mistake that actually happens. A wrap-up opens
 * at 23:00 and is routinely answered after midnight, when the live clock has
 * already rolled over — and a model that reads the clock files the meal a day
 * late. That mistake always produces a date LATER than the day being logged,
 * so a later date is pulled back. An earlier date is left alone, because that
 * is a person saying "that was yesterday's lunch", and they mean it.
 *
 * Pure, so the rule is tested without a database.
 *
 * @param {object} p
 * @param {string} [p.requested]   what the model sent, if anything
 * @param {string} [p.flowLogDate] the open night routine's LOG DATE, if one is open
 * @param {string} p.today         the user's today, "YYYY-MM-DD"
 * @returns {{ date: string, note: string|null }} note explains any change, for the model
 */
export function pickLogDate({ requested, flowLogDate = null, today }) {
    const anchor = flowLogDate ?? today;
    const readable = typeof requested === "string" && /^\d{4}-\d{2}-\d{2}/.test(requested)
        ? requested.slice(0, 10)
        : null;

    if (!requested) return { date: anchor, note: null };
    if (!readable) {
        return { date: anchor, note: `"${requested}" is not a YYYY-MM-DD date, so this was filed under ${anchor}.` };
    }
    if (readable > anchor) {
        const whose = flowLogDate ? "the night routine's LOG DATE" : "today";
        return { date: anchor, note: `${readable} is after ${whose}, so this was filed under ${anchor}.` };
    }
    return { date: readable, note: null };
}

/**
 * pickLogDate, with the flow and the user's timezone read from the database.
 *
 * An open flow past its expiresAt is ignored: getOpenFlowsForUser expires those
 * lazily, and a tool can run before it has had the chance to.
 */
export async function resolveLogDate(userId, requested) {
    const db = await getDB();
    const now = new Date();

    const [user, night] = await Promise.all([
        db.collection(USERS).findOne({ userId }, { projection: { timezone: 1 } }),
        db.collection(ACTIVE_FLOWS).findOne(
            { userId, flowType: "goodNight", state: "open", expiresAt: { $gt: now } },
            { sort: { startedAt: -1 }, projection: { startedAt: 1 } }
        ),
    ]);

    const timeZone = user?.timezone || IST_TIMEZONE;
    return {
        ...pickLogDate({
            requested,
            flowLogDate: night ? localDateOf(night.startedAt, timeZone) : null,
            today: localDateOf(now, timeZone),
        }),
        timeZone,
    };
}
