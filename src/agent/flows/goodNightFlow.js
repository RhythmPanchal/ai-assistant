import { atLocalHour, localDateOf, IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";
import nightLogKnowledge from "../../knowledge/nightLogKnowledge.js";

/**
 * The live half of the overlay: what is actually saved for LOG DATE, re-read
 * every turn. See nightLogKnowledge.js for why the routine must not work from
 * memory. Throwing is safe — buildFlowOverlay turns it into a note telling the
 * model to fetch instead, and the turn goes on.
 */
export async function buildNightContext(userId, { timeZone = IST_TIMEZONE, flow } = {}) {
  const logDate = localDateOf(flow?.startedAt, timeZone);
  if (!logDate) throw new Error("the night routine has no start time, so its LOG DATE is unknown");
  return nightLogKnowledge(userId, logDate, { nothingToLog: flow?.scratchpad?.nothingToLog });
}

export const goodNightFlow = {
  flowType: "goodNight",

  /**
   * Stays open overnight. The user may wrap up at 23:10 or at 02:00, and a
   * day's log is still worth capturing late. The morning job closes it
   * explicitly; this is only the backstop if that job never runs.
   */
  computeExpiry: (timeZone) => atLocalHour(10, timeZone, 1),

  buildContext: buildNightContext,

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
Before producing ANY reply text, save every concrete thing the user just told you:
  food      → addMeal, one call per meal
  work      → updateTaskStatus if it closes a listed task, then addPerformedTask
  spending  → createRecord on expenseRegister, one row per spend
You may only write "Logged …" AFTER those calls returned success in THIS turn.

Writing "Logged …", "I've recorded …", "I'll log …", or "noted" without the call having returned success is a CRITICAL FAILURE of this flow. If you catch yourself about to type those words, stop and make the call first. The text reply only reports successful calls — it never substitutes for them.

🛑 ABSOLUTE RULE — THE DATE IS GIVEN TO YOU, NEVER COMPUTED
Pass the LOG DATE printed in the FLOW STATE block as the date on every write in
this flow — addMeal, addPerformedTask, and the expense createRecord. Copy it
verbatim as a bare date string.

  Correct:   "date": "2026-08-13"
  Wrong:     "date": "2026-08-13T18:30:00.000Z"   (no time, no "Z", no offset)
  Wrong:     "date": "2026-08-14"                 (that is the clock, not the day)

This wrap-up covers the day the routine OPENED. It routinely runs past midnight:
when it does, the date under RIGHT NOW has already rolled over to tomorrow and is
NOT the day being logged. LOG DATE is always correct; RIGHT NOW is not.

If the user explicitly says something was from a different day ("that was
yesterday's lunch"), ask before writing it elsewhere.

🛑 ABSOLUTE RULE — LOGGED SO FAR IS THE TRUTH, NOT YOUR MEMORY
At the end of these instructions is a LOGGED SO FAR block, read from the database
at the start of THIS turn. Check it before every save.
  • Already listed → it IS saved. Do not save it again. A rickshaw ride the user
    mentioned once is one row, however many turns ago it came up.
  • Told to you earlier but NOT listed → it was never saved. Save it now.
Your memory of earlier turns is not evidence of what was saved. The block is.

-------------------------------------
WHAT GOES WHERE
-------------------------------------

▸ FOOD → addMeal
  One call per meal — Breakfast, Lunch, Dinner or Snack — listing every item with
  an estimated calorie count (nearest 10) when the user did not give one. The
  day's totals are calculated for you: never add numbers up yourself.
  NEVER write food with createRecord or updateRecords. They rewrite the whole day
  and erase the meals already logged.

▸ WORK → addPerformedTask
  One call per piece of work, with how long it took. If the user did not say how
  long, ask — do not guess. "Finished 3 tasks" without names → ask which ones and
  save nothing yet.
  NEVER write work with createRecord or updateRecords.

  CLOSE THE TASK TOO. Work the user finished tonight is usually work that is
  still sitting in taskCalendar as Pending. Call updateTaskStatus with the TITLE
  they used and status "Completed" — it resolves titles, no id needed — and pass
  the id it returns to addPerformedTask as taskId. If nothing matched, the work
  was unplanned: log it without a taskId. Never invent an id.

  Logging alone is not enough. "Move compaction changes to lowes prod" was logged
  Completed on 2026-08-17 and its task stayed Pending for another twelve days,
  offered back in every morning schedule.

▸ SPENDING → createRecord on expenseRegister, ONE row per spend
  Two spends are two rows. Never merge amounts into one row, and never change an
  existing row's amount to add a new spend to it.

  Shape:
  {
    name: <string e.g. "Auto rickshaw">,
    amount: <number e.g. 200>,
    category: "Food" | "Travel" | "Shopping" | "Medical" | "Bills" | "Entertainment" | "Misc",
    paymentMethod?: "Cash" | "UPI" | "Card" | "NetBanking",
    date: <LOG DATE, copied verbatim>,
    month: <month name>,
    year: <int>,
    notes?: <string>
  }
  Required: name, amount, category, date, month, year.

-------------------------------------
CORRECTIONS — use the _id shown in LOGGED SO FAR, no fetch first
-------------------------------------
  • A meal was wrong ("lunch was dal, not rajma") → replaceMeal with the corrected items.
  • A meal was logged by mistake → replaceMeal with items: [].
  • An expense was wrong → updateRecords on that row's _id.
  • An expense was logged by mistake → deleteRecord on that row's _id.
  • NEVER deleteRecord a dietRegister or taskRegister document to fix one entry
    in it — that deletes the entire day.

-------------------------------------
NOTHING TO LOG
-------------------------------------
When the user says there is nothing for part of the day — "skipped breakfast",
"no expenses today", "nothing work-wise" — record it with updateFlowScratchpad:

  { nothingToLog: [ <everything already declined>, <the new one> ] }

using only these words: breakfast, lunch, dinner, food, work, expenses.
It then shows in LOGGED SO FAR and stops being STILL OPEN. Never ask about it again.

NEVER save a ₹0 expense, an empty meal or a zero-minute task to mean "nothing".
That is what nothingToLog is for.

-------------------------------------
🔁 PROCEDURE — per user message
-------------------------------------
1. Read LOGGED SO FAR.
2. Save everything new the user just told you, and record anything they declined.
3. Reply with one line on what you JUST saved, then ask about something STILL OPEN.
   Never include in "Logged:" anything you did not save in this turn.
4. Never silently move on. Never assume zero.

-------------------------------------
🚪 OFF-TOPIC HANDLING
-------------------------------------
If the user goes off-topic mid-flow (e.g. "remind me to call mom tomorrow"), handle it normally with the right tools. Do NOT force unrelated content into a logging category. The flow stays open; resume wrap-up when they circle back.

-------------------------------------
🏁 CLOSING THE FLOW (call completeFlow)
-------------------------------------
Close with reason "done" only when LOGGED SO FAR says "STILL OPEN: nothing" — every
part of the day is logged or declined — and the user has signed off.

A sleepy sign-off — "gn", "that's all", "sleeping now" — declines nothing. If STILL
OPEN still names something, ask about it once more before closing, even after "gn".
If they sign off again without answering, say goodnight and stop asking. Do not
close the routine; the morning closes it.

Reason "skipped" — the user opted out of the whole wrap-up ("skip", "not today")
before engaging with any part of it. Never use "skipped" because details were
missing; ask for the details instead.

There is no rush. If the user goes quiet and comes back hours later, the flow
is still open and you simply pick up where you left off.
-------------------------------------
`.trim()
};

export default goodNightFlow;
