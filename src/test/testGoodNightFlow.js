/**
 * Hand-run end-to-end script for the goodNight flow.
 *
 *   node src/test/testGoodNightFlow.js
 *
 * What it does (in order):
 *   1. Calls goodNightJob() — opens an activeFlows row + sends the opener to Telegram.
 *      Snapshot the row.
 *   2. Calls runAgent() with a simulated user reply that covers food + tasks + expense.
 *      The runAgent code path is what real Telegram replies go through, so the
 *      goodNight overlay should be auto-applied here.
 *      Snapshot the row again — should still be "open".
 *   3. Calls runAgent() again with a wrap-up message. The agent's overlay says
 *      this is when to call completeFlow.
 *      Snapshot the row — should now be "completed" with closedBy "agent".
 *
 * Side effects you should be aware of:
 *   - 3 real Telegram messages to chatId 1136575387 (opener + 2 agent replies).
 *   - 1 activeFlows row (will be left in "completed" state if all goes well).
 *   - Potentially N records in dietRegister / taskRegister / expenseRegister.
 *   - N chatHistory rows (one per runAgent turn).
 *   - Real Gemini calls (quota counts).
 * No cleanup is performed — matches the existing src/test/*.js convention.
 */

import "dotenv/config";
import { getDB } from "../tools/mongo/mongoClient.js";
import { goodNightJob } from "../scheduler/jobs/goodNightJob.js";
import { runAgent } from "../agent/agent.js";
import { ACTIVE_FLOWS } from "../tools/mongo/schema/activeFlowsSchema.js";

const USER_ID = 1136575387;

function divider(label) {
  console.log("\n" + "═".repeat(72));
  console.log(`  ${label}`);
  console.log("═".repeat(72));
}

async function getLatestGoodNightFlow() {
  const db = await getDB();
  return db
    .collection(ACTIVE_FLOWS)
    .find({ userId: USER_ID, flowType: "goodNight" })
    .sort({ startedAt: -1 })
    .limit(1)
    .next();
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

async function main() {
  divider("STEP 1 — trigger goodNightJob (open flow + send opener)");
  const jobRes = await goodNightJob();
  console.log(
    "telegram send:",
    jobRes && typeof jobRes === "object" && "ok" in jobRes
      ? jobRes.ok
        ? "ok"
        : jobRes
      : jobRes
  );
  console.log("flow row:", summarizeFlow(await getLatestGoodNightFlow()));

  divider("STEP 2 — simulate user reply (overlay should auto-apply)");
  const replyText =
    "had idli sambhar for breakfast and dal-rice for dinner, finished 3 tasks today, spent 200 on auto rickshaw";
  console.log("user  >>", replyText);
  const agentReply1 = await runAgent(USER_ID, replyText);
  console.log("\nagent <<", agentReply1);
  console.log("\nflow row after reply 1:", summarizeFlow(await getLatestGoodNightFlow()));

  divider("STEP 3 — simulate user wrap-up (should trigger completeFlow)");
  const wrapText = "that's all, going to sleep, gn";
  console.log("user  >>", wrapText);
  const agentReply2 = await runAgent(USER_ID, wrapText);
  console.log("\nagent <<", agentReply2);
  console.log("\nflow row after wrap-up:", summarizeFlow(await getLatestGoodNightFlow()));

  divider("DONE");
  console.log("Check Telegram for the 3 outbound messages.");
  console.log("Check mongo dietRegister / taskRegister / expenseRegister for today's writes.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ test failed:", err);
  process.exit(1);
});
