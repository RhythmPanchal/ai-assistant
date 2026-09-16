import { BaseTool, ToolResult } from "../BaseTool.js";
import { addMeal, replaceMeal, describeDay, MEAL_TYPES } from "../../../tools/mongo/operation/dietLog.js";

/**
 * The only way food reaches dietRegister.
 *
 * Declared globally, not behind a skill: food is mentioned at any hour ("had
 * poha", mid-sentence about something else), and the in-passing defaults route
 * it here. Two declarations are worth it against the alternative — the model
 * rebuilding a day's whole meals list through updateRecords, which wiped lunch
 * the first time an eval asked for meals one at a time.
 */

const ITEM_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string", description: "What was eaten, e.g. 'dal chawal'." },
        quantity: { type: "string", description: "How much, in the user's terms, e.g. '1 plate', '2 rotis'." },
        calories: {
            type: "integer",
            description: "Estimated calories for this item. Required — estimate from nutritional knowledge (nearest 10) when the user did not say.",
        },
        protein: { type: "integer", description: "Grams, estimated. Optional." },
        carbs: { type: "integer", description: "Grams, estimated. Optional." },
        fat: { type: "integer", description: "Grams, estimated. Optional." },
    },
    required: ["name", "quantity", "calories"],
};

const DATE_PARAM = {
    type: "string",
    description:
        "YYYY-MM-DD. The day being logged. In the night routine, copy LOG DATE. Omit for today. " +
        "Only set an earlier date when the user says the meal was from an earlier day.",
};

export class AddMealTool extends BaseTool {
    static name = "addMeal";
    static description =
        "Log ONE meal the user ate. It is added to that day's food log — the day is created if needed — " +
        "and the day's calorie and macro totals are recalculated for you, so never add numbers up yourself. " +
        "Call it once per meal; several addMeal calls in one turn are fine. " +
        "NEVER write food with createRecord or updateRecords: those rewrite the whole day and erase meals already logged. " +
        "To change or remove a meal that is already logged, use replaceMeal instead.";
    static parameters = {
        type: "object",
        properties: {
            mealType: { type: "string", enum: MEAL_TYPES, description: "Which meal this was." },
            items: { type: "array", description: "Everything eaten in this meal.", items: ITEM_SCHEMA },
            date: DATE_PARAM,
        },
        required: ["mealType", "items"],
    };

    async execute({ userId, mealType, items, date }) {
        try {
            const r = await addMeal(userId, { mealType, items, date });
            const note = r.note ? ` Note: ${r.note}` : "";
            return new ToolResult(
                true,
                `Logged ${r.meal.mealType} (${r.meal.mealCalories} kcal) for ${r.date}.${note} Day now: ${describeDay(r.day)}`,
                { date: r.date, dietRegisterId: String(r.day._id), meal: r.meal, dailyTotals: r.day.dailyTotals }
            );
        } catch (err) {
            // Back to the model rather than thrown, so it can fix the call — a
            // missing calorie estimate is the usual one — in the same turn.
            return new ToolResult(false, `Meal not logged: ${err.message}`);
        }
    }
}

export class ReplaceMealTool extends BaseTool {
    static name = "replaceMeal";
    static description =
        "Correct or remove a meal that is ALREADY logged. " +
        "'lunch was actually dal chawal, not rajma' → replaceMeal with the corrected items. " +
        "'remove that snack, it was yesterday's' → replaceMeal with items: []. " +
        "The whole meal is replaced by what you send, and totals are recalculated. " +
        "Not for a second meal of the same type — two snacks is addMeal twice.";
    static parameters = {
        type: "object",
        properties: {
            mealType: { type: "string", enum: MEAL_TYPES, description: "The logged meal to correct." },
            items: {
                type: "array",
                description: "The corrected items, replacing the old ones entirely. Pass [] to remove the meal.",
                items: ITEM_SCHEMA,
            },
            occurrence: {
                type: "integer",
                description: "Only when several meals of this type are logged (two snacks): which one, counting from 1.",
            },
            date: DATE_PARAM,
        },
        required: ["mealType", "items"],
    };

    async execute({ userId, mealType, items, occurrence, date }) {
        try {
            const r = await replaceMeal(userId, { mealType, items, occurrence, date });
            const note = r.note ? ` Note: ${r.note}` : "";
            const what = r.removed
                ? `Removed ${mealType} (${r.previous.items.map(i => i.name).join(", ")})`
                : `Replaced ${mealType}: ${r.previous.items.map(i => i.name).join(", ")} → ${r.meal.items.map(i => i.name).join(", ")}`;
            return new ToolResult(
                true,
                `${what} for ${r.date}.${note} Day now: ${describeDay(r.day)}`,
                { date: r.date, dietRegisterId: String(r.day._id), dailyTotals: r.day.dailyTotals }
            );
        } catch (err) {
            return new ToolResult(false, `Meal not changed: ${err.message}`);
        }
    }
}
