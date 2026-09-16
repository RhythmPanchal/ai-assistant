import { getDB } from "../mongoClient.js";
import { DIET_REGISTER } from "../schema/dietRegisterSchema.js";
import ValidateSchema from "../validateSchema.js";
import { localDayRange } from "../dateUtils.js";
import { resolveLogDate } from "./logDate.js";

/**
 * Meals in and out of a day's food log, with the arithmetic done here.
 *
 * dietRegister is one document per day holding every meal and the day's
 * totals. Through createRecord and updateRecords the model owned all of it:
 * adding lunch meant re-sending the WHOLE meals list — leave breakfast out and
 * it is gone — and adding up the totals itself. In prod that path had never run
 * once, because the fixed night opener collected the whole day in one message.
 * The first eval that asked for meals one at a time wiped lunch when dinner
 * arrived, and a correction left the stored total at 380 over meals summing to
 * 0.
 *
 * So the model now supplies ONE meal, and nothing else: no list to rebuild, no
 * totals, no choice between create and update. Both writes are a single atomic
 * update, which matters more than it looks — a turn runs its tool calls in
 * parallel, so "breakfast was poha, lunch was dal" is two addMeal calls racing
 * for the same document.
 */

export const MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Snack"];

// One of each per day. A second Dinner is almost never a second dinner: in the
// Phase 1 night eval it was the model re-reading the previous turn and saving
// "pizza and pasta at party" beside the "pizza and pasta" it had already saved,
// double-counting the day's calories. Snacks are genuinely plural and stay so.
export const ONCE_A_DAY = ["Breakfast", "Lunch", "Dinner"];
const MACROS = ["protein", "carbs", "fat"];
const DUPLICATE_KEY = 11000;

/**
 * Totals from whatever meals the document holds AFTER the change, computed by
 * Mongo in the same update — never carried over from a previous total, and
 * never supplied by the model.
 */
const sumItems = (field) => ({
    $sum: { $map: { input: "$meals", as: "m", in: { $sum: `$$m.items.${field}` } } },
});
const RECOMPUTE_TOTALS = {
    $set: {
        dailyTotals: {
            caloriesConsumed: { $sum: "$meals.mealCalories" },
            protein: sumItems("protein"),
            carbs: sumItems("carbs"),
            fat: sumItems("fat"),
        },
    },
};

const toInt = (v) => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * The model's items, made storable — or an Error whose message tells it what to
 * fix. Calories are required because the schema requires them and the model is
 * told to estimate; a missing number is sent back rather than stored as zero,
 * which would read as "ate nothing".
 */
export function normalizeMealItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error("items must list at least one thing eaten, e.g. [{ name: \"dal chawal\", quantity: \"1 plate\", calories: 450 }].");
    }

    return items.map((raw, i) => {
        const name = typeof raw?.name === "string" ? raw.name.trim() : "";
        if (!name) throw new Error(`items[${i}] has no name.`);

        const calories = toInt(raw.calories);
        if (calories === null) {
            throw new Error(`"${name}" has no calories. Estimate them from nutritional knowledge (nearest 10) and call again.`);
        }

        const item = {
            name,
            quantity: typeof raw.quantity === "string" && raw.quantity.trim() ? raw.quantity.trim() : "not specified",
            calories,
        };
        for (const macro of MACROS) {
            const value = toInt(raw[macro]);
            if (value !== null) item[macro] = value;
        }
        return item;
    });
}

export function buildMeal(mealType, items) {
    if (!MEAL_TYPES.includes(mealType)) {
        throw new Error(`mealType must be one of ${MEAL_TYPES.join(", ")}. Got: ${mealType}`);
    }
    const clean = normalizeMealItems(items);
    return { mealType, items: clean, mealCalories: clean.reduce((n, x) => n + x.calories, 0) };
}

function dayFields(date, timeZone) {
    const { start, end } = localDayRange(date);
    return {
        date: start,
        // Matched as a range, not by equality on midnight. A day written before
        // the date handling was fixed can sit a few hours off midnight; an
        // equality filter would miss it and the upsert would create a second
        // document for the same day beside it.
        within: { $gte: start, $lt: end },
        month: new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", month: "long" }),
        year: Number(date.slice(0, 4)),
        timeZone,
    };
}

/** What the model is told back: the whole day as it now stands. */
export function describeDay(doc) {
    const meals = (doc?.meals ?? []).map(m =>
        `${m.mealType}: ${m.items.map(i => i.name).join(", ")} (${m.mealCalories} kcal)`
    );
    return meals.length
        ? `${meals.join(" · ")}. Day total: ${doc.dailyTotals?.caloriesConsumed ?? 0} kcal.`
        : "No meals logged for this day.";
}

/**
 * Append one meal to the day, creating the day if needed.
 */
export async function addMeal(userId, { mealType, items, date } = {}) {
    // Validated before anything is read, so a malformed call costs no queries.
    const meal = buildMeal(mealType, items);
    await ValidateSchema(DIET_REGISTER, { meals: [meal] }, { skipRequired: true });

    const { date: logDate, note, timeZone } = await resolveLogDate(userId, date);
    const { date: day, within, month, year } = dayFields(logDate, timeZone);
    const now = new Date();
    const db = await getDB();

    // A main meal already logged is reported, not added. The read gives the
    // model its message; the $cond below is what holds when two calls race.
    const onceADay = ONCE_A_DAY.includes(meal.mealType);
    if (onceADay) {
        const existing = await db.collection(DIET_REGISTER).findOne({ userId, date: within });
        const logged = (existing?.meals ?? []).find(m => m.mealType === meal.mealType);
        if (logged) return { date: logDate, note, meal: logged, day: existing, duplicate: true };
    }

    const appended = { $concatArrays: [{ $ifNull: ["$meals", []] }, [{ $literal: meal }]] };
    const alreadyHasIt = { $in: [meal.mealType, { $ifNull: ["$meals.mealType", []] }] };

    const update = [
        {
            $set: {
                // Set here rather than taken from the filter: a range filter
                // gives an upsert nothing to copy onto the new document.
                date: { $ifNull: ["$date", day] },
                month: { $ifNull: ["$month", month] },
                year: { $ifNull: ["$year", year] },
                meals: onceADay ? { $cond: [alreadyHasIt, { $ifNull: ["$meals", []] }, appended] } : appended,
                createdAt: { $ifNull: ["$createdAt", now] },
                updatedAt: now,
            },
        },
        RECOMPUTE_TOTALS,
    ];

    const write = () => db.collection(DIET_REGISTER).findOneAndUpdate(
        { userId, date: within },
        update,
        { upsert: true, returnDocument: "after" }
    );

    let doc;
    try {
        doc = await write();
    } catch (err) {
        // Two addMeal calls in one turn, on a day with no document yet, can both
        // try to insert it; the unique (userId, date) index refuses the second.
        // By the time it retries the document exists, so the retry appends.
        if (err?.code !== DUPLICATE_KEY) throw err;
        doc = await write();
    }

    return { date: logDate, note, meal, day: doc, duplicate: false };
}

/**
 * Replace one logged meal with new items, or remove it when items is empty.
 *
 * `occurrence` is 1-based among meals of that type, and only needed when there
 * are several — two snacks, say. It refuses to guess: replacing the wrong snack
 * is the kind of silent mistake nobody notices for weeks.
 */
export async function replaceMeal(userId, { mealType, items, occurrence, date } = {}) {
    if (!MEAL_TYPES.includes(mealType)) {
        throw new Error(`mealType must be one of ${MEAL_TYPES.join(", ")}. Got: ${mealType}`);
    }
    const removing = !Array.isArray(items) || items.length === 0;
    const replacement = removing ? null : buildMeal(mealType, items);
    if (replacement) await ValidateSchema(DIET_REGISTER, { meals: [replacement] }, { skipRequired: true });

    const { date: logDate, note, timeZone } = await resolveLogDate(userId, date);
    const { within } = dayFields(logDate, timeZone);
    const db = await getDB();

    // Optimistic concurrency: the write only lands if the day is unchanged since
    // it was read. A concurrent addMeal in the same turn makes it re-read rather
    // than overwrite the meal that just arrived.
    for (let attempt = 1; attempt <= 3; attempt++) {
        const current = await db.collection(DIET_REGISTER).findOne({ userId, date: within });
        if (!current) {
            throw new Error(`Nothing is logged for ${logDate}. To log a meal, use addMeal.`);
        }

        const positions = (current.meals ?? [])
            .map((m, index) => ({ m, index }))
            .filter(({ m }) => m.mealType === mealType);

        if (positions.length === 0) {
            throw new Error(`No ${mealType} is logged for ${logDate}. To log it, use addMeal. Logged: ${describeDay(current)}`);
        }
        if (positions.length > 1 && !occurrence) {
            const listed = positions.map(({ m }, i) => `${i + 1}) ${m.items.map(x => x.name).join(", ")}`).join("  ");
            throw new Error(`There are ${positions.length} ${mealType} entries for ${logDate}: ${listed}. Call again with occurrence set to the one you mean.`);
        }
        const pick = positions.length === 1 ? 0 : Number(occurrence) - 1;
        if (!(pick >= 0 && pick < positions.length)) {
            throw new Error(`occurrence must be between 1 and ${positions.length}.`);
        }

        const target = positions[pick].index;
        const previous = current.meals[target];
        const meals = current.meals
            .map((m, i) => (i === target ? replacement : m))
            .filter(Boolean);

        const doc = await db.collection(DIET_REGISTER).findOneAndUpdate(
            { _id: current._id, updatedAt: current.updatedAt ?? null },
            [{ $set: { meals: { $literal: meals }, updatedAt: new Date() } }, RECOMPUTE_TOTALS],
            { returnDocument: "after" }
        );
        if (doc) return { date: logDate, note, removed: removing, previous, meal: replacement, day: doc };
    }

    throw new Error(`${logDate} kept changing while this correction was being written. Try again.`);
}
