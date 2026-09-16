/**
 * Night wrap-up conversations, and what the database must look like after each.
 *
 * Checked against the DATABASE, not the replies. The failure being guarded is
 * the assistant saying "Logged ✓" over a row that is missing, wrong, or was
 * overwritten by the next turn — and a reply can read perfectly while that
 * happens. What landed in Mongo is the only honest measure.
 *
 * Replies are scripted, so each one is written to make sense whatever the
 * assistant asked before it: people volunteer things out of order, and a
 * wrap-up that only works when the user answers the exact question asked is
 * not the one being built.
 *
 * `seed` is today's context before the routine opens — what the user said
 * during the day, and what was already logged. Seeds are written straight to
 * the collections, never through the code under test, so a broken write path
 * cannot make its own starting data look right.
 */

const meal = (mealType, ...items) => ({ mealType, items });
const item = (name, calories, quantity = "1 serving") => ({ name, quantity, calories });

const mealsOf = (s, type) => s.meals.filter(m => m.mealType === type);
const mealText = (s, type) => mealsOf(s, type).flatMap(m => m.items.map(i => i.name)).join(" | ");
const amounts = (s) => s.expenses.map(e => e.amount).sort((a, b) => a - b);
const taskTitles = (s) => s.performed.map(t => t.title).join(" | ");

// A reply that ASKS about money — the question sentence itself, not anything
// else in the reply. "Logged ₹0. What did you get done today?" mentions money
// and asks a question, but the question is about tasks; judging the whole reply
// flagged exactly that on the first baseline.
//
// "Spend" is not always money: "how much time did you spend on those tasks?"
// flagged a Phase 1 run that was asking about work, and "…marked off expenses,
// could you tell me how long that debugging work took?" flagged a later one.
// A question about how long something took is not a question about spending.
const asksAboutMoney = (text) => String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .some(sentence => sentence.includes("?")
        && /spen[dt]|expens|money|kharch|paid|₹/i.test(sentence)
        && !/\btime\b|hours?|minutes?|\bmins?\b|how long|\btook\b|duration/i.test(sentence));

// Exact counts, not presence. Presence checks passed a Phase 1 run that had
// saved dinner twice and logged a deck review the user never reported doing.
const tasksExactly = (n, why) => ({ why, fn: s => s.performed.length === n, detail: s => `${s.performed.length}: ${taskTitles(s) || "none"}` });
const noExpenses = (why) => ({ why, fn: s => s.expenses.length === 0, detail: s => JSON.stringify(amounts(s)) });

export const NIGHT_SCENARIOS = [
    {
        name: "party-opener",
        why: "the day mentioned a party; the opener should ask about it, and adding dinner must not wipe lunch",
        seed: {
            chat: [
                { user: "morning! busy one today, deck review with ankit", assistant: "Good luck with the review." },
                { user: "office party tonight probably, will be back late", assistant: "Have fun — we can wrap up whenever you're back." },
            ],
            meals: [meal("Lunch", item("dal chawal", 450, "1 plate"))],
            expenses: [{ name: "Coke bottle", amount: 30, category: "Food" }],
        },
        replies: [
            "was fun yaar, had pizza and pasta there. rickshaw back was 50",
            "skipped breakfast today",
            "finished the Q3 deck review with ankit, took around 2 hours. that's all, gn",
        ],
        checks: [
            { why: "opener asks about the party today's chat mentioned", fn: s => /party/i.test(s.opener) },
            { why: "dinner at the party is logged", fn: s => /pizza|pasta/i.test(mealText(s, "Dinner")) },
            { why: "LUNCH SURVIVES dinner being added later", fn: s => /dal/i.test(mealText(s, "Lunch")), detail: s => mealText(s, "Lunch") || "(no lunch)" },
            { why: "₹30 and ₹50 are two rows, nothing merged or overwritten", fn: s => JSON.stringify(amounts(s)) === "[30,50]", detail: s => JSON.stringify(amounts(s)) },
            { why: "the deck work is logged as a performed task", fn: s => /deck/i.test(taskTitles(s)), detail: s => taskTitles(s) || "(none)" },
            tasksExactly(1, "only the deck review is logged — a plan mentioned in the morning is not work done"),
            { why: "exactly one dinner", fn: s => mealsOf(s, "Dinner").length === 1, detail: s => `${mealsOf(s, "Dinner").length} dinners` },
        ],
    },

    {
        name: "no-event-opener",
        why: "nothing social happened; the opener must not invent an event, and a 'no expenses' must stick",
        seed: {
            chat: [
                { user: "standup ran long, then back to back debugging all day", assistant: "Rough one. Hope the bug gave in." },
            ],
        },
        replies: [
            "had poha in the morning, rajma chawal for lunch and roti sabzi for dinner",
            "no expenses today",
            "fixed the login bug, took like 3 hours. gn",
        ],
        checks: [
            { why: "opener invents no party, outing or celebration", fn: s => !/party|celebrat|birthday|wedding|outing|night out/i.test(s.opener), detail: s => s.opener },
            { why: "breakfast, lunch and dinner all logged", fn: s => ["Breakfast", "Lunch", "Dinner"].every(t => mealsOf(s, t).length), detail: s => s.meals.map(m => m.mealType).join(",") || "(no meals)" },
            { why: "no expense rows on a day with no spending", fn: s => s.expenses.length === 0, detail: s => JSON.stringify(amounts(s)) },
            { why: "does not ask about money again after 'no expenses today'", fn: s => s.turns.slice(1).every(t => !asksAboutMoney(t.agent)), detail: s => s.turns.slice(1).map(t => t.agent).find(asksAboutMoney) },
            { why: "the bug fix is logged as a performed task", fn: s => /login|bug/i.test(taskTitles(s)), detail: s => taskTitles(s) || "(none)" },
            tasksExactly(1, "the bug fix is logged exactly once"),
        ],
    },

    {
        name: "meals-across-turns",
        why: "one meal per message — the path where adding a meal to an existing day has never once run in prod",
        seed: {},
        replies: [
            "breakfast was 2 aloo parathas",
            "lunch was dal chawal",
            "dinner was paneer butter masala with 2 rotis",
            "no spends today and nothing work-wise to log. gn",
        ],
        checks: [
            { why: "BREAKFAST SURVIVES two later meals", fn: s => /paratha/i.test(mealText(s, "Breakfast")), detail: s => mealText(s, "Breakfast") || "(no breakfast)" },
            { why: "LUNCH SURVIVES a later meal", fn: s => /dal/i.test(mealText(s, "Lunch")), detail: s => mealText(s, "Lunch") || "(no lunch)" },
            { why: "dinner logged", fn: s => /paneer|roti/i.test(mealText(s, "Dinner")), detail: s => mealText(s, "Dinner") || "(no dinner)" },
            tasksExactly(0, "no work logged — the user said nothing work-wise"),
            noExpenses("no expenses — the user said no spends"),
        ],
    },

    {
        name: "meal-correction",
        why: "a correction replaces the meal instead of adding a second lunch",
        seed: {},
        replies: [
            "lunch was rajma chawal",
            "wait sorry, lunch was actually dal chawal, not rajma",
            "that's it for food. no expenses, no tasks. gn",
        ],
        checks: [
            { why: "exactly one lunch after the correction", fn: s => mealsOf(s, "Lunch").length === 1, detail: s => `${mealsOf(s, "Lunch").length} lunch entries` },
            { why: "the lunch is the corrected one", fn: s => /dal/i.test(mealText(s, "Lunch")) && !/rajma/i.test(mealText(s, "Lunch")), detail: s => mealText(s, "Lunch") },
            tasksExactly(0, "no work logged — the user said no tasks"),
            noExpenses("no expenses — the user said none"),
        ],
    },

    {
        name: "expense-across-turns",
        why: "₹30 then ₹50 in separate messages — two rows, never one ₹80 or a ₹50 over the ₹30",
        seed: {},
        replies: [
            "spent 30 on a coke",
            "oh and 50 on rickshaw",
            "nothing else. didn't eat anything proper today and no tasks either. gn",
        ],
        checks: [
            { why: "two expense rows, ₹30 and ₹50", fn: s => JSON.stringify(amounts(s)) === "[30,50]", detail: s => JSON.stringify(amounts(s)) },
            tasksExactly(0, "no work logged — the user said no tasks"),
        ],
    },

    {
        name: "falls-asleep",
        why: "one reply then silence — what was said must already be saved, with no final turn to do it",
        seed: {},
        replies: [
            "had chicken biryani for dinner, 250 from the place downstairs",
        ],
        checks: [
            { why: "dinner saved without a closing turn", fn: s => /biryani/i.test(mealText(s, "Dinner")), detail: s => mealText(s, "Dinner") || "(no dinner)" },
            { why: "₹250 saved without a closing turn", fn: s => amounts(s).includes(250), detail: s => JSON.stringify(amounts(s)) },
            tasksExactly(0, "no work invented for a user who went to sleep"),
            { why: "₹250 saved exactly once", fn: s => amounts(s).filter(a => a === 250).length === 1, detail: s => JSON.stringify(amounts(s)) },
        ],
    },

    {
        name: "medical-expense",
        why: "a doctor's bill must land — the night instructions and the schema disagree on the category name",
        seed: {},
        replies: [
            "went to the doctor for my throat, spent 800 on consultation and medicines",
            "nothing else to log tonight, gn",
        ],
        checks: [
            { why: "₹800 row saved", fn: s => amounts(s).includes(800), detail: s => JSON.stringify(amounts(s)) },
            { why: "filed as Medical", fn: s => s.expenses.some(e => e.amount === 800 && e.category === "Medical"), detail: s => JSON.stringify(s.expenses.map(e => [e.amount, e.category])) },
            tasksExactly(0, "a doctor's visit is not logged as work"),
            { why: "₹800 saved exactly once", fn: s => amounts(s).filter(a => a === 800).length === 1, detail: s => JSON.stringify(amounts(s)) },
        ],
    },
];

export default NIGHT_SCENARIOS;
