import "dotenv/config";
import { runAgent } from "../agent/agent.js";
import { getUserProfile, createUserProfile, updateUserProfile } from "../agent/userManager.js";
import { closeDB } from "../tools/mongo/mongoClient.js";

async function main() {
    const prompt = process.argv[2];
    if (!prompt) {
        console.error(JSON.stringify({ success: false, error: "No prompt provided" }));
        process.exit(1);
    }

    const userId = 999999;
    try {
        // Fetch the user profile of the real user 1021482398
        const realUser = await getUserProfile(1021482398);
        const apiKeys = realUser ? realUser.apiKeys : undefined;

        // Ensure test user exists
        let user = await getUserProfile(userId);
        if (!user) {
            user = await createUserProfile(userId, {
                name: "Test User",
                age: 25,
                profession: "QA Engineer",
                dailySchedule: "9 AM to 6 PM",
                lifestyle: "Balanced",
                timezone: "Asia/Kolkata",
                preferences: { triggersOptIn: false },
                apiKeys
            });
        } else {
            if (apiKeys) {
                await updateUserProfile(userId, { apiKeys });
                user = await getUserProfile(userId);
            }
        }

        console.log(`[TEST RUNNER] Running agent loop for prompt: "${prompt}"`);
        const result = await runAgent(userId, prompt, user);
        console.log(JSON.stringify({ success: true, response: result }));
    } catch (error) {
        console.error(JSON.stringify({
            success: false,
            error: error.message,
            stack: error.stack
        }));
        process.exitCode = 1;
    } finally {
        await closeDB();
        process.exit(process.exitCode || 0);
    }
}

main();
