/**
 * Schedule furniture — the blocks a day is made of that are not tasks.
 *
 * "Lunch", "Unwind & Sleep", "Personal time / catch up" are things that happen
 * in a timeline. Nobody achieves them, nobody wants to be reminded of them, and
 * they do not belong in a backlog. They got into taskCalendar because a slot and
 * a task look identical to the model — a title with a duration — and once one is
 * in, it is Pending forever and every weekend adds another copy. `Personal time
 * / catch up` has been sitting in the backlog since 2026-08-17 for exactly this
 * reason.
 *
 * So they are named once, here, and refused at the door by createTask. In a
 * schedule they stay what they always were: a slot with category "Routine".
 *
 * The matcher is deliberately conservative. It splits a title on separators and
 * only calls it furniture when EVERY fragment is furniture — so "Dinner &
 * Unwind" is caught while "Book a dinner reservation" and "Buy a table & lamp"
 * are not. A false positive here blocks a real task, which is far worse than
 * letting one more "Free time" row through.
 */

/** The category every non-task slot carries in userSchedule.slots. */
export const ROUTINE_CATEGORY = "Routine";

// Whole fragments only — never substrings. "tea" must not match "team sync".
const FURNITURE = new Set([
    // meals
    "breakfast", "brunch", "lunch", "dinner", "supper", "snack", "snacks",
    "tea", "chai", "coffee", "meal", "meals", "eat", "food",
    // pauses
    "break", "breaks", "short break", "long break", "rest", "resting",
    "down time", "downtime", "buffer", "buffer time", "slack", "contingency",
    // leisure
    "relax", "relaxing", "unwind", "wind down", "winding down", "chill",
    "free time", "personal time", "me time", "leisure", "family time",
    "catch up", "catchup", "personal", "downtime / rest",
    // sleep
    "sleep", "sleeping", "sleep prep", "bed", "bedtime", "nap", "night",
    // getting going
    "morning routine", "night routine", "evening routine", "daily routine",
    "routine", "get ready", "getting ready", "freshen up", "bath", "shower",
    // moving about
    "commute", "travel", "travel home", "drive home", "transit",
    // day boundaries
    "wrap up", "wrapup", "wrap-up", "review", "daily review", "planning",
    "plan the day", "day planning", "misc", "miscellaneous", "other", "tbd",
]);

// A morning draft writes slots as "Work: Fix the thing"; when one of those is
// handed to createTask the category prefix comes with it and would otherwise
// stop the fragment matching.
const CATEGORY_PREFIX =
    /^(work|personal|health|finance|fitness|self[- ]improvement|learning|study|misc)\s*[:\-–]\s*/i;

const SEPARATORS = /\s*(?:\/|&|\+|,|·|—|–|\band\b|\bthen\b)\s*/;

function normalise(title) {
    return String(title ?? "")
        .toLowerCase()
        // Emoji, brackets and trailing punctuation are decoration, not content.
        // Variation selectors and ZWJ survive the pictographic class and would
        // leave an invisible character glued to the word.
        .replace(/[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{200D}]/gu, " ")
        .replace(/[()[\]{}]/g, " ")
        .replace(CATEGORY_PREFIX, "")
        .replace(/[.!?:;]+$/, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * True when `title` names a block of the day rather than something to achieve.
 *
 * @param {string} title
 * @returns {boolean}
 */
export function isRoutineBlock(title) {
    const normalised = normalise(title);
    if (!normalised) return false;

    if (FURNITURE.has(normalised)) return true;

    const fragments = normalised.split(SEPARATORS).map(f => f.trim()).filter(Boolean);
    if (fragments.length > 1 && fragments.every(f => FURNITURE.has(f))) return true;

    // "Lunch Break" and "Tea Break" carry no separator at all. Only attempted on
    // a short title, and still only when every word is furniture, so "team sync"
    // and "buy table" are untouched.
    const words = normalised.split(" ");
    return words.length > 1 && words.length <= 3 && words.every(w => FURNITURE.has(w));
}

/**
 * What createTask says when it turns one away. Written to the model rather than
 * to a log: it has to explain the distinction well enough that the model does
 * the right thing instead of retrying with a reworded title.
 */
export function routineBlockRefusal(title) {
    return (
        `"${title}" is a block of the day, not a task. Meals, breaks, commutes, ` +
        `wind-down and personal time belong in the day's timeline — put it in ` +
        `insertSchedule as a slot with category "${ROUTINE_CATEGORY}" and taskRef null. ` +
        `Do not add it to taskCalendar: it can never be completed, so it would sit ` +
        `in the backlog forever and be added again the next time the day is planned.`
    );
}
