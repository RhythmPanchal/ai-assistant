import { runAgent } from "../../agent/agent.js";
import pendingTasksKnowledge from "../../knowledge/pendingTasksKnowledge.js";
import taskLogKnowledge from "../../knowledge/taskLogKnowledge.js";
import { sendMessage } from "../../tools/telegram/sendMessage.js";

export async function goodMorningJob() {
  //TODO : fix this, run for all users. 
  const userId = 1136575387; //temp. hardcoding 

  const [pendingTasks, taskLogs] = await Promise.all([
    pendingTasksKnowledge(userId),
    taskLogKnowledge(userId),
  ]);

  const MorningInstruction = `
        You need to create an optimal schedule for today, with a fine good morning message.

Here are the user's pending tasks:
${pendingTasks}

Step 1: Analyze past 7 days
${taskLogs}
I have given past 7 days task done by user use that.
* Identify patterns:
  → When user is most productive
  → Types of tasks completed (work/personal/health)
  → Any delays or incomplete patterns

Step 2: Understand constraints
* If weekday:
  → User is mostly in office during 10AM to 8PM.
  → during office hours mostly done office tasks, some time office tasks come unexpectedly sometimes It is organised.
* If weekend:
  → User some times go to tour/explore.
  → Assign more personal + deep work tasks

Step 3: Prioritize tasks
* High priority + urgent → earliest slots
* Medium → flexible slots
* Low → optional / end of day

Step 4: Output format
* Clean and structured timeline
* Include time ranges (approximate is fine)
* Mention task name + short purpose

Step 5: Present schedule and ask for confirmation
* Present the schedule to the user in a clean, readable format.
* At the end, ask the user to confirm the schedule or suggest changes.
* Do NOT call insertSchedule yet — wait for user confirmation.
* If the user requests changes, modify the schedule accordingly and present it again.
* ONLY after the user explicitly confirms/approves the schedule, call insertSchedule with:
  → userId: the user's id (integer)
  → date: today's date as ISO string (e.g., "2026-05-01")
  → slots: array of ALL scheduled time blocks, each with:
    - slotId: sequential like "slot_1", "slot_2", "slot_3", etc.
    - startTime: "HH:mm" format (24-hour)
    - endTime: "HH:mm" format (24-hour)
    - title: activity name
    - category: Work / Personal / Health / Finance / etc.
    - priority: Low / Medium / High (based on task importance)
    - status: "Planned" for all slots
    - taskRef: null (no linking at this stage)
    - notes: any extra context, else null
  → summary: brief overview of the day plan
  → motivationalNote: the motivational message
* Do NOT use createRecord for schedules — always use insertSchedule.
* Once the schedule is inserted, no further updates from the agent.

Important rules:
* Optimize for productivity + realism
* If very few tasks → include self-improvement or maintenance tasks

Goal:
Create a practical, realistic, and optimized day plan tailored to the user's behavior and constraints, along with a motivational message. Present it to the user for review. Only save it after confirmation.
    `
  let res;
  try {
    // this job completes with a single message only meanwhile this job might required multiple chat with llm, so we will add a trigger whenever insertSchedule is called we will complete this job till then this job instruction must be going to llm. 
    // with trigger we need to create some other features also. 
    const goodMorningMessage = await runAgent(userId, MorningInstruction);
    res = await sendMessage(userId, goodMorningMessage);
  } catch (error) {
    throw new Error(`Caught error while running Good morning job: ${error.message}`);
  }

  return res;
}


/*current job in mongo: 
{
  "title": "Good Morning Routine",
  "userId": -1,
  "type": "recurring",
  "recurring": true,
  "cronPattern": "0 9 * * *",
  "timeZone": "Asia/Kolkata",
  "actionType": "goodMorningJob",
  "payload": {},
  "status": "active",
  "attempts": 0,
  "maxAttempts": 3,
  "lastExecutedAt": null,
  "nextExecutionAt": { "$date": "2026-03-31T08:30:00.000Z" },
  "expiryDate": null,
  "failedAt": null,
  "createdAt": { "$date": "2026-03-30T00:00:00.000Z" },
  "updatedAt": { "$date": "2026-03-30T00:00:00.000Z" }
}
*/