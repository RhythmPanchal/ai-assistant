import { MongoClient } from "mongodb";

import { ACTIVE_FLOWS, ACTIVE_FLOWS_INDEXES } from "./schema/activeFlowsSchema.js";
import { CHAT_HISTORY, CHAT_HISTORY_INDEXES } from "./schema/chatHistorySchema.js";
import { CHAT_SUMMARY, CHAT_SUMMARY_INDEXES } from "./schema/chatSummarySchema.js";
import { CONNECTION, CONNECTION_INDEXES } from "./schema/connectionSchema.js";
import { COUNTERS, COUNTERS_INDEXES } from "./schema/countersSchema.js";
import { DIET_REGISTER, DIET_REGISTER_INDEXES } from "./schema/dietRegisterSchema.js";
import { EXPENSE_REGISTER, EXPENSE_REGISTER_INDEXES } from "./schema/expenseRegisterSchema.js";
import { FACT_KEY, FACT_KEY_INDEXES } from "./schema/factKeySchema.js";
import { OAUTH_CONNECTOR, OAUTH_CONNECTOR_INDEXES } from "./schema/oauthConnectorSchema.js";
import { TASK_CALENDAR, TASK_CALENDAR_INDEXES } from "./schema/taskCalendarSchema.js";
import { TASK_REGISTER, TASK_REGISTER_INDEXES } from "./schema/taskRegisterSchema.js";
import { TRIGGER_JOB, TRIGGER_JOB_INDEXES } from "./schema/triggerJobSchema.js";
import { USER_FACT, USER_FACT_INDEXES } from "./schema/userFactSchema.js";
import { USER_IDENTITY, USER_IDENTITY_INDEXES } from "./schema/userIdentitySchema.js";
import { USER_SCHEDULE, USER_SCHEDULE_INDEXES } from "./schema/userScheduleSchema.js";
import { USERS, USERS_INDEXES } from "./schema/usersSchema.js";

const uri = process.env.MONGO_DB_URI; // from Atlas
const client = new MongoClient(uri);

let db;

export async function getDB() {
    if (!db) {
        await client.connect();
        db = client.db(process.env.MONGODB_DB_NAME);
        console.log("✅ MongoDB connected");
    }
    return db;
}

/**
 * Every collection's indexes, sourced from the schema file that owns it.
 *
 * llmUsage is the one entry declared here rather than in a schema file — it has
 * no schema module, only the LLM_USAGE constant in agent/llm/usageMeter.js, and
 * the mongo layer should not reach up into the agent layer to import it.
 */
const LLM_USAGE = "llmUsage";

const INDEX_REGISTRY = [
    [ACTIVE_FLOWS, ACTIVE_FLOWS_INDEXES],
    [CHAT_HISTORY, CHAT_HISTORY_INDEXES],
    [CHAT_SUMMARY, CHAT_SUMMARY_INDEXES],
    [CONNECTION, CONNECTION_INDEXES],
    [COUNTERS, COUNTERS_INDEXES],
    [DIET_REGISTER, DIET_REGISTER_INDEXES],
    [EXPENSE_REGISTER, EXPENSE_REGISTER_INDEXES],
    [FACT_KEY, FACT_KEY_INDEXES],
    [OAUTH_CONNECTOR, OAUTH_CONNECTOR_INDEXES],
    [TASK_CALENDAR, TASK_CALENDAR_INDEXES],
    [TASK_REGISTER, TASK_REGISTER_INDEXES],
    [TRIGGER_JOB, TRIGGER_JOB_INDEXES],
    [USER_FACT, USER_FACT_INDEXES],
    [USER_IDENTITY, USER_IDENTITY_INDEXES],
    [USER_SCHEDULE, USER_SCHEDULE_INDEXES],
    [USERS, USERS_INDEXES],
    // findOneAndUpdate({ userId, ptDate }, …, { upsert: true }) once per turn.
    // unique: without it two concurrent turns can both miss and both insert,
    // splitting a day's usage across two documents.
    [LLM_USAGE, [{ key: { userId: 1, ptDate: 1 }, name: "userId_1_ptDate_1", unique: true }]],
];

/**
 * Create any index in the registry that does not already exist.
 *
 * Called once at boot, after getDB(). Safe to run on every start: existing
 * indexes are skipped by name, and createIndex is itself idempotent for an
 * identical spec.
 *
 * NEVER throws. An index build is not worth refusing to start the bot over,
 * and one failure is expected until the duplicate rows from before these
 * constraints existed are cleaned up — a unique index cannot be built over
 * data that already violates it. Failures are collected and reported at the
 * end with the collection named, so the log says exactly what to fix.
 */
export async function ensureIndexes() {
    const database = await getDB();
    const created = [];
    const failed = [];
    let present = 0;

    for (const [collectionName, specs] of INDEX_REGISTRY) {
        if (!specs?.length) continue;

        // listIndexes throws on a collection that does not exist yet; an empty
        // set is the right answer there, and createIndex will create it.
        let existing = new Set();
        try {
            const current = await database.collection(collectionName).listIndexes().toArray();
            existing = new Set(current.map(i => i.name));
        } catch {
            existing = new Set();
        }

        for (const { key, ...options } of specs) {
            if (existing.has(options.name)) { present++; continue; }

            try {
                await database.collection(collectionName).createIndex(key, options);
                created.push(`${collectionName}.${options.name}`);
            } catch (err) {
                failed.push({ collectionName, name: options.name, err });
            }
        }
    }

    if (created.length) console.log(`[indexes] created ${created.length}: ${created.join(", ")}`);
    console.log(`[indexes] ${present} already present, ${failed.length} failed`);

    for (const { collectionName, name, err } of failed) {
        // 11000 duplicate key, 85/86 an index of this name/shape already exists
        // with different options.
        const duplicate = err.code === 11000 || /duplicate key/i.test(err.message);
        console.error(
            `[indexes] ${collectionName}.${name} FAILED — ${err.message}` +
            (duplicate
                ? `\n           ${collectionName} already holds rows that violate this constraint. ` +
                  `De-duplicate them, then restart to build the index.`
                : "")
        );
    }

    return { created, present, failed: failed.map(f => `${f.collectionName}.${f.name}`) };
}
