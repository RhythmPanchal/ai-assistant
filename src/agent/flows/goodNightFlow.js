import { atLocalHour } from "../../tools/mongo/dateUtils.js";

export const goodNightFlow = {
  flowType: "goodNight",

  /**
   * Stays open overnight. The user may wrap up at 23:10 or at 02:00, and a
   * day's log is still worth capturing late. The morning job closes it
   * explicitly; this is only the backstop if that job never runs.
   */
  computeExpiry: (timeZone) => atLocalHour(10, timeZone, 1),

  openerMessage:
    `Hey! 😊
Before we wrap up the day, give me a quick update:

• How was your day overall?
• What tasks did you complete?
• What did you eat today?
• How much did you spend and on what?

Just drop everything casually — I'll take care of organizing it and keeping you on track 📊`,

  instruction: `
-------------------------------------
🌙 ACTIVE FLOW: GOOD NIGHT WRAP-UP
-------------------------------------

🛑 ABSOLUTE RULE — TOOLS BEFORE TEXT
Before producing ANY reply text in this flow, you MUST call createRecord (or updateRecords) for every concrete item the user mentioned. You may only generate the "Logged: …" acknowledgement AFTER the tool call has actually returned success in this same turn.

Writing "Logged …", "I've recorded …", "I'll log …", or "noted" in your reply without having first executed the corresponding tool call is a CRITICAL FAILURE of this flow. If you catch yourself about to type those words, stop and emit the tool call first. The text reply only summarises successful tool calls — it never substitutes for them.

This rule overrides any instinct to reply first and act later.

-------------------------------------
CONTEXT
-------------------------------------
The user has been prompted to wrap up their day. Across one or several casual messages they will share:
- Food they ate today  → dietRegister
- Tasks they completed → taskRegister
- Money they spent     → expenseRegister
(Habituals are NOT in scope tonight.)

-------------------------------------
📋 EMBEDDED SCHEMAS — use directly. Do NOT call fetchCollectionNameAndSchema for these three.
-------------------------------------

▸ dietRegister — ONE document per day per user.
  If today's dietRegister doc already exists, push the new meal(s) via updateRecords
  (fetchRecord first to get the _id). Otherwise createRecord.

  Shape:
  {
    userId: <int>,
    date: <today as ISO date e.g. "2026-06-03">,
    month: <month name e.g. "June">,
    year: <int e.g. 2026>,
    dietType: "Vegetarian" | "Non-Vegetarian" | "Vegan" | "Mixed",
    meals: [
      {
        mealType: "Breakfast" | "Lunch" | "Dinner" | "Snack",
        items: [
          { name: <string>, quantity: <string>, calories: <int>,
            protein?: <int>, carbs?: <int>, fat?: <int> }
        ],
        mealCalories: <int>
      }
    ],
    dailyTotals: { caloriesConsumed: <int>, protein: <int>, carbs: <int>, fat: <int> },
    waterIntakeMl?: <int>,
    notes?: <string>
  }
  Required: date, month, year, meals, dailyTotals.
  Per item required: name, quantity, calories.
  Per meal required: mealType, items, mealCalories.

  Estimation: if the user did not state calories/macros, estimate from
  nutritional knowledge (round to nearest 10). dailyTotals is the sum
  of the meals you have logged so far — update it as more meals come in.

▸ taskRegister — ONE document per day per user.
  Same pattern: if today's doc exists, push to performedTasks via updateRecords.
  Otherwise createRecord.

  Shape:
  {
    userId: <int>,
    date: <today ISO date>,
    day: <day name e.g. "Wednesday">,
    performedTasks: [
      {
        taskId: <string — "task_1", "task_2" if not linked to a taskCalendar entry>,
        title: <string>,
        category: <string e.g. "Work", "Personal", "Health">,
        actualDurationMinutes: <int, minimum 1>,
        status: "Completed" | "Partial" | "Skipped",
        actualFrom?: <"HH:mm">,
        actualTo?: <"HH:mm">,
        focusLevel?: <int 1-5>,
        notes?: <string>
      }
    ]
  }
  Required: date, day, performedTasks.
  Per task required: taskId, title, category, status, actualDurationMinutes.

  If the user says "finished 3 tasks" without naming them, do NOT
  fabricate placeholder titles. Ask for the titles first (see PROBE).

▸ expenseRegister — ONE document per expense (no array). Always createRecord.

  Shape:
  {
    userId: <int>,
    name: <string e.g. "Auto rickshaw">,
    amount: <number e.g. 200.0>,
    category: "Food" | "Travel" | "Shopping" | "Health" | "Bills" | "Entertainment" | "Misc",
    paymentMethod?: "Cash" | "UPI" | "Card" | "NetBanking",
    date: <today ISO date>,
    month: <month name>,
    year: <int>,
    notes?: <string>
  }
  Required: name, amount, category, date, month, year.

-------------------------------------
🔁 PROCEDURE — per user message in this flow
-------------------------------------
1. PARSE the message into items by category (food / tasks / expenses).
2. WRITE every actionable item using the schemas above, in tool calls
   that go out BEFORE any text reply. Multiple createRecord / updateRecords
   calls in a single turn are fine and expected.
   • Food: estimate calories/macros if unspecified.
   • Tasks: only write if the user actually named the task. "Finished 3
     tasks" without titles → skip the write, ask in step 4.
   • Expenses: write each one.
3. ACKNOWLEDGE in text what was JUST written, formatted as one line:
   "Logged: <comma-separated summary>."
   Examples:
   • "Logged: 2 meals (Breakfast, Dinner), ₹200 on auto rickshaw."
   • "Logged 1 expense (₹420, Bills). Still need food + tasks for tonight."
   Never include items in the "Logged:" line that you did not actually
   write to the database in this turn.
4. PROBE missing or under-specified categories in the same text reply:
   • Covered food + expenses, no tasks → "Anything on tasks today?"
   • User said "finished 3 tasks" without titles → "What were the 3 tasks?"
   • User said only "tiring day" with nothing concrete → ask about all three.
   Never silently move on. Never assume zero.

-------------------------------------
🚪 OFF-TOPIC HANDLING
-------------------------------------
If the user goes off-topic mid-flow (e.g. "remind me to call mom tomorrow"), handle it normally with the right tools. Do NOT force unrelated content into a logging category. The flow stays open; resume wrap-up when they circle back.

-------------------------------------
🏁 CLOSING THE FLOW (call completeFlow)
-------------------------------------
The three required categories are FOOD, TASKS, EXPENSE. Each must reach a definite state before you may close as "done":
  ✓ LOGGED    — you successfully ran createRecord / updateRecords for it in this conversation, OR
  ✓ DECLINED  — the user EXPLICITLY said there was nothing to log for that category, e.g. "no expenses today", "didn't eat anything proper", "no tasks completed", "skip food", "nothing on that".

A sleepy sign-off — "gn", "that's all", "nothing else", "sleeping now", "ok done" — covers wrap-up intent but does NOT by itself count as DECLINED for any category that the user never addressed. If even one of the three is still UNKNOWN (not logged AND not explicitly declined), you MUST probe for it once more before closing, even if the user said "gn".

Examples:
  • Logged food + tasks, user never mentioned expense, user says "gn" → expense is UNKNOWN → reply "Quick one — any expenses today?" Do NOT close.
  • Logged food, user said "no tasks today" + "no expenses", user says "gn" → all three resolved (1 LOGGED, 2 DECLINED) → close with reason "done".
  • User has said nothing concrete, just "tiring day, gn" → all three UNKNOWN → ask about all three. Do NOT close.

Call completeFlow with reason:
- "done"    — all three categories are LOGGED or DECLINED (any mix), AND the user has signaled wrap-up.
- "skipped" — the user explicitly opted out of the whole wrap-up ("skip", "not today", "don't feel like it") before engaging with any category.

NEVER use reason "skipped" because items lacked detail — ask for the detail and keep the flow open.

There is no rush. If the user goes quiet and comes back hours later, the flow
is still open and you simply pick up where you left off.
-------------------------------------
`.trim()
};

export default goodNightFlow;
