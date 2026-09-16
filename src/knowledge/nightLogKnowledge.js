import { getDB } from "../tools/mongo/mongoClient.js";
import { DIET_REGISTER } from "../tools/mongo/schema/dietRegisterSchema.js";
import { TASK_REGISTER } from "../tools/mongo/schema/taskRegisterSchema.js";
import { EXPENSE_REGISTER } from "../tools/mongo/schema/expenseRegisterSchema.js";
import { USER_SCHEDULE } from "../tools/mongo/schema/userScheduleSchema.js";
import { localDayRange } from "../tools/mongo/dateUtils.js";

/**
 * What is actually saved for the day being wrapped up, read fresh every turn.
 *
 * The night routine used to work from memory. Tool results are stripped from
 * chat history, so on its third turn the model could see it had CALLED
 * createRecord but not whether anything landed — and it re-derived what was
 * logged from a growing transcript each time. The first eval showed both ways
 * that fails: a ₹50 rickshaw saved three times, and "fixed the login bug, three
 * hours" never saved at all.
 *
 * This block replaces the memory with the database. A missed item shows up as
 * missing on the next turn and gets saved; a saved one shows up as saved and
 * does not get saved again. It also carries every _id, so a correction is one
 * call rather than a fetch first.
 *
 * Nothing here is written back: it is a read, rebuilt per turn, same as the
 * morning routine's LIVE DATA block.
 */

const MAIN_MEALS = ["Breakfast", "Lunch", "Dinner"];

// The words the routine is told to use in scratchpad.nothingToLog, and the
// near-misses a model writes instead. Normalised here so "tasks" and "work"
// both stop the question being asked.
const NOTHING_ALIASES = {
    breakfast: "breakfast", lunch: "lunch", dinner: "dinner",
    food: "food", meals: "food", eating: "food",
    work: "work", tasks: "work", task: "work",
    expenses: "expenses", expense: "expenses", spending: "expenses", money: "expenses",
};

export function normaliseNothingToLog(list) {
    return [...new Set((Array.isArray(list) ? list : [])
        .map(x => NOTHING_ALIASES[String(x).trim().toLowerCase()])
        .filter(Boolean))];
}

const rupees = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

/**
 * Pure render, so the block's rules — above all what counts as still open — are
 * tested without a database.
 */
export function renderLoggedSoFar({ logDate, diet = [], tasks = [], expenses = [], schedule = null, nothingToLog = [] }) {
    const nothing = new Set(normaliseNothingToLog(nothingToLog));
    const out = [
        "-------------------------------------",
        `📒 LOGGED SO FAR FOR ${logDate} — read from the database at the top of THIS turn`,
        "-------------------------------------",
        "This is what is actually saved. Trust it over your memory of earlier turns.",
        "  • Something the user told you that is NOT below was NOT saved — save it now.",
        "  • Something that IS below is saved — never save it a second time.",
        "",
    ];

    // FOOD — normally one document; any stray second one is shown, not hidden.
    const meals = diet.flatMap(d => (d.meals ?? []).map(m => ({ ...m, docId: d._id })));
    if (meals.length) {
        out.push(`FOOD  (dietRegister _id ${diet.map(d => String(d._id)).join(", ")})`);
        for (const m of meals) {
            out.push(`  ${m.mealType.padEnd(10)} ${m.items.map(i => i.name).join(", ")} (${m.mealCalories} kcal)`);
        }
        const total = diet.reduce((n, d) => n + (d.dailyTotals?.caloriesConsumed ?? 0), 0);
        out.push(`  ${"Day total".padEnd(10)} ${total} kcal`);
    } else {
        out.push("FOOD  nothing logged yet");
    }

    // WORK
    const work = tasks.flatMap(t => t.performedTasks ?? []);
    if (work.length) {
        out.push("", `WORK  (taskRegister _id ${tasks.map(t => String(t._id)).join(", ")})`);
        for (const t of work) out.push(`  ${t.title} — ${t.status}, ${t.actualDurationMinutes} min`);
    } else {
        out.push("", "WORK  nothing logged yet");
    }

    // EXPENSES — one row each, with its own _id, and the total added up HERE so
    // the model never has to.
    if (expenses.length) {
        out.push("", "EXPENSES  (expenseRegister, one row per spend)");
        for (const e of expenses) {
            out.push(`  _id ${e._id}  ${rupees(e.amount).padEnd(8)} ${String(e.category ?? "").padEnd(13)} ${e.name ?? ""}`);
        }
        out.push(`  Total ${rupees(expenses.reduce((n, e) => n + (Number(e.amount) || 0), 0))}`);
    } else {
        out.push("", "EXPENSES  nothing logged yet");
    }

    if (nothing.size) {
        out.push("", `THE USER SAID THERE IS NOTHING TO LOG FOR: ${[...nothing].join(", ")}`,
            "  Do not ask about these again.");
    }

    if (schedule?.slots?.length) {
        out.push("", "PLANNED FOR THE DAY (their schedule — what was meant to happen)");
        for (const s of schedule.slots) out.push(`  ${s.startTime}–${s.endTime}  ${s.title}`);
    }

    // STILL OPEN: what the wrap-up has neither saved nor been told to skip.
    const open = [];
    if (!nothing.has("food")) {
        const logged = new Set(meals.map(m => m.mealType));
        const missing = MAIN_MEALS.filter(t => !logged.has(t) && !nothing.has(t.toLowerCase()));
        if (missing.length) open.push(missing.join(", ").toLowerCase());
    }
    if (!work.length && !nothing.has("work")) open.push("work done today");
    if (!expenses.length && !nothing.has("expenses")) open.push("spending");

    out.push("", open.length
        ? `STILL OPEN: ${open.join(" · ")}`
        : "STILL OPEN: nothing — every part of the day is either logged or declined.");

    return out.join("\n");
}

export default async function nightLogKnowledge(userId, logDate, { nothingToLog = [] } = {}) {
    const { start, end } = localDayRange(logDate);
    const day = { userId, date: { $gte: start, $lt: end } };
    const db = await getDB();

    const [diet, tasks, expenses, schedule] = await Promise.all([
        db.collection(DIET_REGISTER).find(day).toArray(),
        db.collection(TASK_REGISTER).find(day).toArray(),
        db.collection(EXPENSE_REGISTER).find(day).sort({ createdAt: 1 }).toArray(),
        db.collection(USER_SCHEDULE).findOne(day),
    ]);

    return renderLoggedSoFar({ logDate, diet, tasks, expenses, schedule, nothingToLog });
}
