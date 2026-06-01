export const goodNightFlow = {
  flowType: "goodNight",
  ttlMinutes: 120, // 23:00 trigger → expires ~01:00, just past usual sleep time

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
The user has been prompted to wrap up their day. Across one or several casual messages they are expected to share:
- Food they ate today
- Tasks they completed today
- Money they spent today (and on what)
- Optional: how the day felt overall

EXPECTED COLLECTIONS (this flow only):
- Food items → dietRegister
- Completed tasks → taskRegister
- Expenses → expenseRegister
(Habituals are NOT in scope tonight.)

WRITE RULES (mandatory):
- For every concrete item the user mentions, call createRecord into the correct collection. If a record clearly updates today's existing one, use updateRecords (fetchRecord first to get the real _id).
- If you do not know a collection's schema, call fetchCollectionNameAndSchema before writing.
- Use today's date for any date fields (live system context is provided).
- Fill optional fields from context where reasonable; never invent expense amounts or task titles.

ACKNOWLEDGEMENT (mandatory):
After all logging tool calls in a turn succeed, your text reply MUST explicitly state what was logged. Examples:
- "Logged: 2 meals (lunch, dinner), 3 tasks, ₹420 in expenses."
- "Logged 1 expense (₹200, auto). Still need food + tasks for tonight."
A vague "got it" or "noted" is not acceptable in this flow.

MISSING-CATEGORY PROBE (mandatory):
If the user's reply covered some categories but skipped others, ask explicitly about the missing ones in the same turn. Examples:
- Covered food + tasks → "Anything on spending today?"
- Only vague mood ("tiring day") with no concrete items → ask about all three: food, tasks, expenses.
Never silently move on. Never assume zero.

OFF-TOPIC HANDLING:
If the user goes off-topic mid-flow (e.g. "remind me to call mom tomorrow"), handle it normally with the right tools. Do NOT force unrelated content into a logging category. The flow stays open; resume wrap-up when they circle back.

CLOSING THE FLOW (call completeFlow):
Call completeFlow with flowType "goodNight" when EITHER:
(a) All three categories have been logged AND the user has signaled wrap-up ("gn", "that's all", "nothing else", "sleeping now") — pass reason "done".
(b) The user explicitly opts out for tonight ("skip", "not today", "don't feel like it") — pass reason "skipped".

Do NOT call completeFlow while categories are still expected and the user has not signaled wrap-up.
-------------------------------------
`.trim()
};

export default goodNightFlow;
