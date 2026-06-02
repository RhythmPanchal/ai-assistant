/**
 * One-shot prompt the morning job hands to runAgent so the agent drafts
 * today's schedule. The overlay instruction (below) then governs every
 * follow-up turn until the user confirms (or skips).
 */
export function buildMorningTriggerPrompt({ pendingTasks, taskLogs }) {
  return `
Draft an optimal schedule for the user today, with a short motivational good-morning message.

Pending tasks:
${pendingTasks}

Past 7 days of completed tasks (for pattern analysis):
${taskLogs}

Procedure:
1. Skim the last 7 days to spot when the user is most productive and what kinds of tasks tend to land where.
2. Apply day-of-week constraints:
   - Weekday: user is in office 10 AM - 8 PM; office work fills that window, sometimes with unplanned items.
   - Weekend: leans personal / deep work / occasional travel.
3. Prioritise: high + urgent earliest, medium flexible, low optional / end of day.
4. Present a clean timeline (time ranges, task name, short purpose). Do NOT call insertSchedule yet.
5. End by asking the user to confirm or suggest changes.

Important:
- If there are very few pending tasks, include self-improvement or maintenance items.
- Optimise for realism over packed days.
`.trim();
}

export const goodMorningFlow = {
  flowType: "goodMorning",
  ttlMinutes: 6 * 60, // 09:00 trigger → expires 15:00 if user never engages

  buildTriggerPrompt: buildMorningTriggerPrompt,

  instruction: `
-------------------------------------
🌅 ACTIVE FLOW: GOOD MORNING SCHEDULE
-------------------------------------

🛑 ABSOLUTE RULE — TOOLS BEFORE CLAIMING SUCCESS
Phrases like "Schedule locked in", "Confirmed", "Saved", "All set", "I've added it", "Done", "Got it" are confirmation announcements. You may NOT include any such phrase in a reply until you have actually called insertSchedule in the same turn AND received a success result. Announcing the schedule is saved without having called the tool is a CRITICAL FAILURE of this flow.

This rule applies AFTER the user has explicitly approved the schedule. During the draft / refine phase you should NOT call insertSchedule at all — just present the timeline and ask. The rule only kicks in once the user has said yes.

This rule overrides any instinct to reply first and act later.

-------------------------------------
A schedule was proposed earlier in this conversation and the user was asked to confirm or adjust it. The user's replies in this flow are about that schedule.

REFINE LOOP:
- If the user requests changes, modify the schedule and present the updated version again.
- Do NOT call insertSchedule until the user has explicitly approved the (possibly updated) schedule.

ON EXPLICIT CONFIRMATION (mandatory):
Call insertSchedule with:
- userId (integer)
- date: today's date as ISO string (e.g. "2026-05-01")
- slots: array of every scheduled time block, each with:
  • slotId: "slot_1", "slot_2", … (sequential)
  • startTime / endTime: "HH:mm" 24-hour
  • title: activity name
  • category: Work / Personal / Health / Finance / etc.
  • priority: Low / Medium / High
  • status: "Planned"
  • taskRef: null (no linking at this stage)
  • notes: extra context, else null
- summary: brief overview
- motivationalNote: the motivational line

Do NOT use createRecord for schedules — always insertSchedule.

ACKNOWLEDGEMENT (mandatory):
After insertSchedule succeeds, confirm to the user in plain text: e.g. "Schedule locked in — have a strong day."

CLOSING THE FLOW (call completeFlow):
Call completeFlow with flowType "goodMorning" right after insertSchedule succeeds and you have acknowledged to the user — pass reason "done".

If the user explicitly opts out ("not today", "skip the schedule"), call completeFlow with reason "skipped" without inserting.

Until insertSchedule has been called (or the user has skipped), keep the flow open and continue refining.
-------------------------------------
`.trim()
};

export default goodMorningFlow;
