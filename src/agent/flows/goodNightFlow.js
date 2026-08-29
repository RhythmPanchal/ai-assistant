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

🛑 ABSOLUTE RULE — THE DATE IS GIVEN TO YOU, NEVER COMPUTED
Every record you write in this flow — dietRegister, taskRegister, expenseRegister —
uses the LOG DATE printed in the FLOW STATE block at the end of these instructions.
Copy it verbatim as a bare date string.

  Correct:   "date": "2026-08-13"
  Wrong:     "date": "2026-08-13T18:30:00.000Z"   (no time, no "Z", no offset)
  Wrong:     "date": "2026-08-14"                 (that is the clock, not the day)

This wrap-up covers the day the routine OPENED. It routinely runs past midnight:
when it does, the date under RIGHT NOW has already rolled over to tomorrow and is
NOT the day being logged. LOG DATE is always correct; RIGHT NOW is not.

Do not adjust it, do not append a time, do not reason about timezones, and do not
re-derive it from what the user says. If the user explicitly says an item was from
a different day ("that was yesterday's lunch"), ask before writing it elsewhere.

The same LOG DATE is also what you filter on when you fetchRecord to check whether
today's document already exists.

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
  If a dietRegister doc for LOG DATE already exists, push the new meal(s) via
  updateRecords (fetchRecord on LOG DATE first to get the _id). Otherwise createRecord.
  Never create a second doc for the same LOG DATE.

  Shape:
  {
    userId: <int>,
    date: <LOG DATE, copied verbatim — e.g. "2026-06-03">,
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
    date: <LOG DATE, copied verbatim>,
    day: <day name e.g. "Wednesday">,
    performedTasks: [
      {
        taskId: <the taskCalendar _id returned by updateTaskStatus below, else null>,
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
    date: <LOG DATE, copied verbatim>,
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

     CLOSE THE TASK TOO. Work the user finished tonight is usually work
     that is still sitting in taskCalendar as Pending. For each named task,
     call updateTaskStatus with the TITLE they used and status "Completed" —
     you do not need an id, it resolves titles. Put the id it returns into
     that entry's taskId so the log points at the task it closed.

     If it comes back saying nothing matched, the work was unplanned:
     taskId null, and log it as normal. Never invent an id.

     Logging alone is not enough. "Move compaction changes to lowes prod"
     was logged Completed on 2026-08-17 and its task stayed Pending for
     another twelve days, offered back in every morning schedule.
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
