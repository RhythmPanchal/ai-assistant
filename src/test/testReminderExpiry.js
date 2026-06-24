import "dotenv/config";
import executeTriggerJob from "../scheduler/executeTriggerJob.js";
import { getDB, closeDB } from "../tools/mongo/mongoClient.js";
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";
import assert from "assert";

async function runTest() {
    const db = await getDB();
    const collection = db.collection(TRIGGER_JOB);

    // ─── Test Case 1: Pre-Execution Expiry ───────────────────────────────────
    console.log("--- TEST CASE 1: Pre-execution expiry ---");
    const expiredJob = {
        title: "Test Expired Reminder",
        userId: 999999,
        type: "recurring",
        recurring: true,
        cronPattern: "*/5 * * * *",
        timeZone: "Asia/Kolkata",
        actionType: "sendMessage",
        payload: { chatId: 999999, text: "This should not send" },
        status: "active",
        attempts: 0,
        maxAttempts: 3,
        lastExecutedAt: null,
        nextExecutionAt: new Date(Date.now() - 5000),
        expiryDate: new Date(Date.now() - 10000),
        createdAt: new Date(),
        updatedAt: new Date()
    };

    const insertResult1 = await collection.insertOne(expiredJob);
    const jobId1 = insertResult1.insertedId;

    try {
        const job = await collection.findOne({ _id: jobId1 });
        const result = await executeTriggerJob(job);
        assert.strictEqual(result, true);

        const updatedJob = await collection.findOne({ _id: jobId1 });
        assert.strictEqual(updatedJob.status, "completed", "Job status should be completed");
        console.log("✅ Test Case 1 passed!");
    } finally {
        await collection.deleteOne({ _id: jobId1 });
    }

    // ─── Test Case 2: Post-Execution Expiry ──────────────────────────────────
    console.log("\n--- TEST CASE 2: Post-execution expiry ---");
    // cron triggers every 5 mins (on multiples of 5).
    // nextExecutionAt is now.
    // expiryDate is 5 seconds from now.
    // The next execution after this one (at the next multiple of 5 minutes) will be past expiryDate.
    const aboutToExpireJob = {
        title: "Test About To Expire Reminder",
        userId: 999999,
        type: "recurring",
        recurring: true,
        cronPattern: "*/5 * * * *",
        timeZone: "Asia/Kolkata",
        actionType: "sendMessage",
        payload: { chatId: 999999, text: "This should send once" },
        status: "active",
        attempts: 0,
        maxAttempts: 3,
        lastExecutedAt: null,
        nextExecutionAt: new Date(),
        expiryDate: new Date(Date.now() + 5000), // 5 seconds from now
        createdAt: new Date(),
        updatedAt: new Date()
    };

    const insertResult2 = await collection.insertOne(aboutToExpireJob);
    const jobId2 = insertResult2.insertedId;

    try {
        const job = await collection.findOne({ _id: jobId2 });
        const result = await executeTriggerJob(job);
        assert.strictEqual(result, true);

        const updatedJob = await collection.findOne({ _id: jobId2 });
        assert.strictEqual(updatedJob.status, "completed", "Status should transition to completed after run");
        assert.strictEqual(updatedJob.nextExecutionAt, null, "nextExecutionAt should be null");
        console.log("✅ Test Case 2 passed!");
    } finally {
        await collection.deleteOne({ _id: jobId2 });
    }

    await closeDB();
}

runTest().catch(err => {
    console.error("❌ Test failed:", err);
    process.exit(1);
});
