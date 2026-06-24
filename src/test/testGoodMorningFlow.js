/**
 * Hand-run end-to-end script for the goodMorning flow.
 *
 *   node src/test/testGoodMorningFlow.js
 *
 * What it does (in order):
 *   1. Calls goodMorningJob() — opens the activeFlows row, fetches
 *      pendingTasks + 7-day taskLog, runs the agent with the trigger
 *      prompt so it drafts a schedule and asks for confirmation, then
 *      sends that draft to Telegram. Snapshot the row.
 *   2. Calls runAgent() with a simulated "looks good, confirm" reply.
 *      The goodMorning overlay tells the agent to call insertSchedule
 *      now, acknowledge, then completeFlow. Snapshot the row again.
 *
 * Side effects you should be aware of:
 *   - Up to 2 real Telegram messages (opener/draft + agent's confirm reply
 *     is NOT pushed to Telegram by this script — only the goodMorningJob
 *     opener is, because that's the only path that calls sendMessage).
 *   - 1 activeFlows row (left in "completed" state if all goes well).
 *   - 1 userSchedule row (will fail with E11000 if today's already exists
 *     — clean up first via mongo if you have one from a prior test).
 *   - N chatHistory rows.
 *   - Real Gemini calls (quota counts; the draft turn is token-heavy
 *     because pendingTasks + taskLogs are inlined).
 * No cleanup is performed — matches the existing src/test/*.js convention.
 */

import "dotenv/config";
import { getDB } from "../tools/mongo/mongoClient.js";
import { getUserProfile } from "../agent/userManager.js";
import { goodMorningJob } from "../scheduler/jobs/goodMorningJob.js";
import { runAgent } from "../agent/agent.js";
import { ACTIVE_FLOWS } from "../tools/mongo/schema/activeFlowsSchema.js";
import { USER_SCHEDULE } from "../tools/mongo/schema/userScheduleSchema.js";

const USER_ID = 1136575387;

function divider(label) {
  console.log("\n" + "═".repeat(72));
  console.log(`  ${label}`);
  console.log("═".repeat(72));
}

async function getLatestGoodMorningFlow() {
  const db = await getDB();
  return db
    .collection(ACTIVE_FLOWS)
    .find({ userId: USER_ID, flowType: "goodMorning" })
    .sort({ startedAt: -1 })
    .limit(1)
    .next();
}

async function getTodaysSchedule() {
  const db = await getDB();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  return db
    .collection(USER_SCHEDULE)
    .findOne({ userId: USER_ID, date: { $gte: startOfDay, $lte: endOfDay } });
}

function summarizeFlow(flow) {
  if (!flow) return "(none)";
  return {
    _id: String(flow._id),
    state: flow.state,
    startedAt: flow.startedAt,
    expiresAt: flow.expiresAt,
    closedAt: flow.closedAt,
    closedBy: flow.closedBy,
    reason: flow.reason,
  };
}

function summarizeSchedule(schedule) {
  if (!schedule) return "(not inserted)";
  return {
    _id: String(schedule._id),
    date: schedule.date,
    day: schedule.day,
    slotsCount: Array.isArray(schedule.slots) ? schedule.slots.length : 0,
    firstSlot: schedule.slots?.[0],
    lastSlot: schedule.slots?.[schedule.slots.length - 1],
    summary: schedule.summary,
    motivationalNote: schedule.motivationalNote,
  };
}

async function main() {
  const realUser = await getUserProfile(1021482398);
  const apiKeys = realUser ? realUser.apiKeys : undefined;
  const user = { userId: USER_ID, name: "Rhythm", dailySchedule: "9 AM to 6 PM", lifestyle: "Productive", timezone: "Asia/Kolkata", apiKeys };

  divider("STEP 1 — trigger goodMorningJob (open flow + draft schedule via agent + send to telegram)");
  // Note: goodMorningJob does the runAgent call internally with the
  // morning trigger prompt, so this single call covers both the flow
  // open and the LLM draft. Expect 5-15s while the agent reasons over
  // pendingTasks + 7-day history.
  const jobRes = await goodMorningJob(user);
  console.log(
    "telegram send:",
    jobRes && typeof jobRes === "object" && "ok" in jobRes
      ? jobRes.ok
        ? "ok"
        : jobRes
      : jobRes
  );
  console.log("flow row:", summarizeFlow(await getLatestGoodMorningFlow()));

  divider("STEP 2 — simulate user confirmation (should insertSchedule then completeFlow)");
  const confirmText = "looks good, confirm and lock it in";
  console.log("user  >>", confirmText);
  const agentReply = await runAgent(USER_ID, confirmText, user);
  console.log("\nagent <<", agentReply);
  console.log("\nflow row after confirm:", summarizeFlow(await getLatestGoodMorningFlow()));

  divider("STEP 3 — verify userSchedule was written");
  const schedule = await getTodaysSchedule();
  console.log("today's userSchedule:", summarizeSchedule(schedule));

  divider("DONE");
  console.log("Check Telegram for the morning draft message.");
  console.log("If insertSchedule failed with E11000, today's userSchedule already exists — drop it and rerun.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ test failed:", err);
  process.exit(1);
});
