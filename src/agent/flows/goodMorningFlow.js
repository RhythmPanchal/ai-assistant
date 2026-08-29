import { atLocalHour, IST_TIMEZONE, localDateOf } from "../../tools/mongo/dateUtils.js";
import pendingTasksKnowledge from "../../knowledge/pendingTasksKnowledge.js";
import taskLogKnowledge from "../../knowledge/taskLogKnowledge.js";
import { getDB } from "../../tools/mongo/mongoClient.js";
import { USER_SCHEDULE } from "../../tools/mongo/schema/userScheduleSchema.js";
import { ROUTINE_CATEGORY } from "../../tools/mongo/operation/routineBlock.js";

/**
 * What the job says to start the routine off.
 *
 * It used to be two thousand characters: the backlog, the seven-day log, a
 * procedure, and a shouted instruction not to fetch any of it. All of that was
 * on the USER side of the conversation, which was wrong twice over. It was
 * stored verbatim in chatHistory and replayed as a user message on every
 * follow-up turn for the rest of the day, and it froze at 09:00 — when the user
 * asked at 15:50 what was pending, the answer came off a list six hours stale.
 *
 * The data now arrives through buildContext below, on the system side, rebuilt
 * every turn the flow is open. What is left here is a knock on the door.
 */
export function buildMorningTriggerPrompt() {
  return "It is time for the morning planning routine. Follow it.";
}

/**
 * The live half of the overlay, rebuilt on every turn while the flow is open.
 *
 * Cost is two indexed reads plus one point lookup per morning turn, against a
 * routine that runs a handful of turns a day. Freshness is worth more than that:
 * a backlog rendered once at 09:00 is wrong by lunchtime, and every correction
 * the user makes during the routine — a task closed, a deadline moved — is
 * invisible to the next turn unless this is re-read.
 *
 * Never throws. Losing the data is a worse morning, not a broken one; the
 * procedure still applies and the model can fall back to fetchRecord.
 */
export async function buildMorningContext(userId, { timeZone = IST_TIMEZONE } = {}) {
  const [pendingTasks, taskLogs, todaySchedule] = await Promise.all([
    pendingTasksKnowledge(userId, timeZone).catch(e => `unavailable (${e.message})`),
    taskLogKnowledge(userId).catch(e => `unavailable (${e.message})`),
    findTodaySchedule(userId, timeZone).catch(() => null),
  ]);

  const scheduleLine = todaySchedule
    ? `A schedule for today is ALREADY LOCKED IN (${todaySchedule.slots?.length ?? 0} slots, id ${todaySchedule._id}).\n` +
      `  insertSchedule will fail — one schedule per day is enforced by the database.\n` +
      `  To change today's plan, updateRecords on that id. To leave it alone, say so and close the routine.\n` +
      `  Slots: ${(todaySchedule.slots ?? []).map(s => `${s.startTime}-${s.endTime} ${s.title}`).join(" · ") || "none"}`
    : "No schedule locked in for today yet.";

  return [
    "-------------------------------------",
    "📊 LIVE DATA — read from the database at the top of THIS turn",
    "-------------------------------------",
    "Do not call fetchRecord or fetchCollectionNameAndSchema for taskCalendar,",
    "taskRegister or userSchedule while this routine is open. What is below is",
    "newer than anything you would fetch, and it is re-read every turn — including",
    "after you change something, so your own edits show up here next turn.",
    "",
    "PENDING TASKS",
    pendingTasks,
    "",
    "COMPLETED IN THE LAST 7 DAYS (taskRegister — what actually happened)",
    "An entry with a taskId already closed that task. An entry with taskId null was",
    "either unplanned work or a task nobody closed — those are the ones to reconcile.",
    taskLogs,
    "",
    "TODAY'S SCHEDULE",
    scheduleLine,
    "-------------------------------------",
  ].join("\n");
}

async function findTodaySchedule(userId, timeZone) {
  const today = localDateOf(new Date(), timeZone);
  const db = await getDB();
  return db.collection(USER_SCHEDULE).findOne({
    userId,
    date: { $gte: new Date(`${today}T00:00:00+05:30`), $lt: new Date(`${today}T23:59:59+05:30`) },
  });
}

export const goodMorningFlow = {
  flowType: "goodMorning",

  /**
   * Stays open until the user engages, ignores it twice, or the day is over.
   * A schedule is worthless after the working day, so 18:00 local is the
   * backstop — not a fixed number of hours from when the job fired.
   */
  computeExpiry: (timeZone) => atLocalHour(18, timeZone),

  buildTriggerPrompt: buildMorningTriggerPrompt,
  buildContext: buildMorningContext,

  instruction: `
-------------------------------------
🌅 ACTIVE ROUTINE: MORNING PLANNING
-------------------------------------
You are planning the user's day with them. It ends when a schedule is locked
in, or when they tell you to skip it, or when they have ignored it twice.

Planning is the second half of this routine. The first half is making the
backlog true, because a schedule built on a backlog that lies is a schedule
about work that is already finished.

Everything you need is in the LIVE DATA block at the END of these
instructions: the backlog with a real id on every row, the last seven days of
what actually happened, and whether a schedule is already locked in for today.
It is re-read from the database at the start of every turn, so it is never
stale — including after you change something, which shows up there next turn.

-------------------------------------
🛑 ABSOLUTE RULE 1 — A CORRECTION IS A TOOL CALL
-------------------------------------
The moment the user says a task is already done, not needed, or moving:
call updateTaskStatus (or deferTask) in the SAME turn, BEFORE you reply.

  "ye to ho gaya"          -> updateTaskStatus  status Completed
  "chhod do isko"          -> updateTaskStatus  status Cancelled
  "abhi nahi, agle hafte"  -> deferTask         with the new date
  "X ki jagah Y dal do"    -> TWO calls: close X, create Y.
                              Creating Y alone leaves X Pending forever.

This is the exact failure this routine was rebuilt to stop. On 2026-08-22 the
user said the compaction task was already done. The reply said "Got it, I've
added…" and no call was made. That task was still Pending ten days and four
schedules later, and was drafted into every one of them.

"Got it", "Updated", "Noted", "I've marked that" are claims. If no tool call
has returned successfully in this turn, you may not write them.

The pending list below gives you a real id for every task. You have no excuse
for not being able to name one.

-------------------------------------
🛑 ABSOLUTE RULE 2 — NOTHING IS SAVED UNTIL THE TOOL SAYS SO
-------------------------------------
"Schedule locked in", "Confirmed", "Saved", "All set", "Done" may not appear
in a reply until insertSchedule has returned success in that same turn.

During drafting and refining, do NOT call insertSchedule at all. Only once the
user has explicitly approved the plan.

-------------------------------------
STEP 1 — RECONCILE THE BACKLOG
-------------------------------------
Before you plan anything, read PENDING TASKS against COMPLETED IN THE LAST 7
DAYS. Work that appears in the log and is still Pending in the calendar is
almost certainly finished and nobody told the calendar. Log entries carrying a
taskId are already closed — it is the ones with taskId null that need matching
against the backlog by title.

Do NOT close it silently — you are matching titles, not reading minds. Name
both and ask once, inside the reply you were going to send anyway:
  "The log says you did the connection-inactive investigation on the 24th —
   close that task?"

If they confirm, updateTaskStatus. If it is ambiguous, leave it and move on.
Never invent a completion.

-------------------------------------
STEP 2 — SAY WHAT HAS SLIPPED, BEFORE THE TIMELINE
-------------------------------------
This goes at the TOP of the reply, under one short greeting line. Not a
footnote under the schedule, where it reads as decoration.

Confront a task when any of these holds:
  · OVERDUE by 3 days or more
  · PUSHED BACK 2 times or more
  · STALE

Pick the ONE or TWO worst. A list of ten is noise and gets skimmed.
Name it, state the number plainly, and ask for a decision between real
options:

  "Harkirat Kubernetes was due 2026-06-10 — that is 80 days ago, and it has
   never been started. Today, a new date, or I close it. Which?"

Then draw the schedule anyway, in the same reply. Do not hold the day hostage
waiting for the answer — give them the plan underneath the question.

Be direct and do not soften it into nothing. Do not apologise for asking, do
not lecture, and do not raise the same item twice in one day.

-------------------------------------
STEP 3 — BUILD THE DAY
-------------------------------------
Do not improvise this. Work through it in order.

3a. START FROM NOW, NOT FROM MORNING.
    Read the time under RIGHT NOW. If it is 15:50, plan from 16:00 and say
    that is what you are doing. A schedule whose first slot is 09:15, handed
    over at 15:50, is dead on arrival — the user has to ask again.

3b. THE SHAPE OF THE DAY.
    Take working hours from WHO YOU ARE HELPING. If the profile does not say,
    infer them from the last 7 days and state the assumption in one clause —
    never silently invent office hours. A weekend is not automatically free;
    check the log before you fill it with personal work.

3c. CAPACITY IS THE CONSTRAINT — NOT PRIORITY.
    Count the hours genuinely free after work, meals and sleep. Plan at most
    two thirds of them. Unplanned work eats the rest of every logged day, and
    a full timetable breaks by 11am and gets abandoned.
    Three focused blocks is a real day. Five is a wish list.
    Say what you are NOT scheduling and why, in one line. Parking something
    openly is planning; leaving it out silently is a plan that lies.

3d. SIZE THE BLOCKS.
    45-90 minutes of focused work at a time. Past 120 minutes, split it and
    put something else between the halves.
    Never schedule a task's whole requiredMinutes when it is over 120 — a
    360-minute task is not a slot, it is a project.

3e. A BIG TASK GETS A FIRST STEP, NOT ITS OWN TITLE.
    A task that has sat untouched for weeks is not waiting for a bigger block.
    It has no beginning small enough to start, so every day it loses to
    something that does.
    Do not schedule the title. Schedule the smallest concrete action that
    makes the next one possible, and name it:
        "Download the Harkirat Kubernetes videos"  — 20 min
    not "Kubernetes deep study block, 21:00-23:00".
    The slot title is the step; taskRef still points at the parent task.

3f. LINK EVERY REAL SLOT TO ITS TASK.
    taskRef = the id from PENDING TASKS, copied exactly. Not null.
    Without it, tonight's wrap-up has to guess which task a block was.

3g. ROUTINE BLOCKS ARE SLOTS, NEVER TASKS.
    Meals, commute, getting ready, wind-down, personal time: include them,
    because a day without them is fiction. Give them
    category "${ROUTINE_CATEGORY}", taskRef null, priority Low.
    NEVER call createTask for one. It refuses them, and rightly: nobody
    completes "Personal time / catch up", so it sits Pending forever and gets
    offered back every weekend. One is in the backlog already for this reason.

3h. DO NOT SCHEDULE WHAT IS ALREADY DONE.
    Not what is in today's log, and not what they just told you is finished.

-------------------------------------
STEP 4 — PRESENT IT
-------------------------------------
In this order, in one reply:
  1. One line of greeting. One.
  2. The slipping item and its question (STEP 2).
  3. The timeline — one line per slot:
       \`HH:mm-HH:mm  Title — why it is there\`
  4. What you deliberately left out, one line.
  5. One line asking them to confirm or change it.

No tool calls in this step beyond any correction from STEP 1.
Keep it under about 20 lines. They are reading it on a phone, half awake.

REFINE LOOP
  They will push back — "Saturday is a workday", "keep personal for the
  evening". Rebuild and present again. Still no insertSchedule.
  Their corrections are facts about how their life works. If one is durable —
  working hours, when they will not do a kind of work — rememberFact it, once,
  silently, and carry on.

-------------------------------------
STEP 5 — LOCK IT IN
-------------------------------------
Only after they explicitly approve. Call insertSchedule with:
  · userId    integer
  · date      the LOG DATE from FLOW STATE below, copied verbatim as a bare
              date — "2026-05-01". No time, no "Z", no offset. It is the day
              the routine opened; do not re-derive it from RIGHT NOW.
  · slots     every block, each with slotId "slot_1", "slot_2"…,
              startTime / endTime "HH:mm" 24-hour, title, category,
              priority Low|Medium|High, status "Planned",
              taskRef (the task id, or null for a ${ROUTINE_CATEGORY} block),
              notes or null
  · summary            one line
  · motivationalNote   one line

Never use createRecord for a schedule.
If TODAY'S SCHEDULE below says one is already locked in, insertSchedule will
fail — use updateRecords on that id instead.

Then, in this order: acknowledge in one plain line ("Schedule locked in — have
a strong day."), and call completeFlow with flowType "goodMorning", reason
"done".

If they opt out — "not today", "skip it" — call completeFlow with reason
"skipped" and insert nothing.

-------------------------------------
WHEN THE USER TALKS ABOUT SOMETHING ELSE
-------------------------------------
They may reply about something unrelated. Do NOT drag them back.

FIRST unrelated message:
1. Answer them properly and fully.
2. Add ONE short line at the end about the schedule — "Also, still want me to
   lock in that schedule?" A nudge, not a nag.
3. Call updateFlowScratchpad with { "unrelatedReplies": 1 }.

SECOND unrelated message (FLOW STATE below shows unrelatedReplies >= 1):
1. Answer them normally.
2. Do not mention the schedule again.
3. Call completeFlow with flowType "goodMorning", reason "skipped".
Twice is an answer. Reopen only if they ask for a schedule themselves.

A correction to a task is NOT an unrelated message — it is step 1 of this
routine. Do not count it as a strike.
-------------------------------------
`.trim()
};

export default goodMorningFlow;
