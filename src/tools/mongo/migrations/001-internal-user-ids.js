/**
 * Hand-run:  node src/tools/mongo/migrations/001-internal-user-ids.js [--apply]
 *
 * DRY RUN BY DEFAULT. Without --apply it only reports what it would change.
 *
 * Repoints every row owned by the original Telegram-chat-id user onto an
 * internal incremental userId, and records the Telegram id as an identity row.
 *
 * RUN THIS BEFORE STARTING THE BOT on the identity-layer code. If the bot gets
 * here first, the legacy user's next message finds no identity, allocates a
 * fresh id, and opens an empty profile while every existing row still sits under
 * the old id. That is repairable — the script below adopts the id the bot minted
 * and repoints onto it — but the clean path is to run this first.
 *
 * Read the checklist it prints at the end. Three code changes have to follow it,
 * in that order, or the bot writes new rows under the old id while reading under
 * the new one.
 */
import "dotenv/config";

import { getDB } from "../mongoClient.js";
import { ACTIVE_FLOWS } from "../schema/activeFlowsSchema.js";
import { CHAT_HISTORY } from "../schema/chatHistorySchema.js";
import { CONNECTION } from "../schema/connectionSchema.js";
import { COUNTERS, USER_ID_SEQUENCE } from "../schema/countersSchema.js";
import { DIET_REGISTER } from "../schema/dietRegisterSchema.js";
import { EXPENSE_REGISTER } from "../schema/expenseRegisterSchema.js";
import { TASK_CALENDAR } from "../schema/taskCalendarSchema.js";
import { TASK_REGISTER } from "../schema/taskRegisterSchema.js";
import { TRIGGER_JOB } from "../schema/triggerJobSchema.js";
import { USER_IDENTITY } from "../schema/userIdentitySchema.js";
import { USER_SCHEDULE } from "../schema/userScheduleSchema.js";
import { USERS } from "../schema/usersSchema.js";

const LEGACY_TELEGRAM_ID = 1136575387;
const TARGET_USER_ID = 1;
const APPLY = process.argv.includes("--apply");

/**
 * Every collection storing userId as an OWNER reference.
 *
 * llmUsage is here despite having no schema module — it carries a unique index
 * on (userId, ptDate), so leaving it behind splits the usage counter.
 *
 * triggerJob.payload.chatId is deliberately NOT in this list and must not be
 * rewritten. It is a Telegram ADDRESS, not an identity; turning it into 1 makes
 * every existing reminder fire into a chat that does not exist.
 */
const OWNED_COLLECTIONS = [
    ACTIVE_FLOWS, CHAT_HISTORY, CONNECTION, DIET_REGISTER, EXPENSE_REGISTER,
    TASK_CALENDAR, TASK_REGISTER, TRIGGER_JOB, USER_SCHEDULE, USERS, "llmUsage",
];

async function main() {
    const db = await getDB();

    console.log(APPLY ? "APPLYING\n" : "DRY RUN — pass --apply to write\n");

    // ── where are we? ────────────────────────────────────────────────────────
    // An existing identity does NOT mean the migration ran. It far more likely
    // means the bot booted first and auto-allocated an id for the legacy user,
    // leaving a stub profile alongside untouched legacy rows. Repair that state
    // rather than refusing: adopt the id the bot minted.
    const existingIdentity = await db.collection(USER_IDENTITY)
        .findOne({ channel: "telegram", externalId: String(LEGACY_TELEGRAM_ID) });
    const targetUserId = existingIdentity?.userId ?? TARGET_USER_ID;

    if (existingIdentity) {
        console.log(`Identity exists: the bot allocated userId ${targetUserId} before this ran.`);
        console.log("Repointing legacy rows onto it instead of minting a second user.\n");
    } else {
        const collision = await db.collection(USERS).findOne({ userId: targetUserId });
        if (collision) {
            throw new Error(`users already holds userId ${targetUserId} — set TARGET_USER_ID to a free id.`);
        }
    }

    // ── report ───────────────────────────────────────────────────────────────
    let total = 0;
    for (const name of OWNED_COLLECTIONS) {
        const count = await db.collection(name).countDocuments({ userId: LEGACY_TELEGRAM_ID });
        total += count;
        console.log(`  ${String(count).padStart(6)}  ${name}`);
    }
    console.log(`  ${String(total).padStart(6)}  TOTAL\n`);

    if (total === 0) {
        console.log("No rows remain under the legacy id. Already migrated — nothing to do.");
        return;
    }

    const otherOwners = await db.collection(CHAT_HISTORY).distinct("userId", { userId: { $ne: LEGACY_TELEGRAM_ID } });
    if (otherOwners.length) {
        console.log(`NOTE: chatHistory also holds rows for ${otherOwners.join(", ")}.`);
        console.log("      This migration only moves the legacy user; those need their own pass.\n");
    }

    if (!APPLY) {
        console.log("Dry run complete. Re-run with --apply to write.");
        return;
    }

    const now = new Date();

    // ── 1. the users row ─────────────────────────────────────────────────────
    const legacyProfile = await db.collection(USERS).findOne({ userId: LEGACY_TELEGRAM_ID });

    if (existingIdentity && legacyProfile) {
        // Two rows for one person: the stub the bot created under targetUserId,
        // and the real legacy profile. Repointing the legacy row would violate
        // the unique index on userId, so the empty stub goes first.
        const removed = await db.collection(USERS).deleteOne({ userId: targetUserId });
        if (removed.deletedCount) {
            console.log(`users: removed the empty stub row for userId ${targetUserId}`);
        }
    }

    if (!legacyProfile) {
        await db.collection(USERS).insertOne({
            userId: targetUserId,
            name: "Rhythm Panchal",
            timezone: "Asia/Kolkata",
            status: "active",
            // MUST be true. resolveRoutineTargets falls back to LEGACY_USER only
            // while no user is opted in — and that fallback points at the old id,
            // which after this migration owns nothing.
            preferences: { triggersOptIn: true },
            onboardedAt: null,
            createdAt: now,
            updatedAt: now,
        });
        console.log(`users: created row for userId ${targetUserId}`);
    } else {
        await db.collection(USERS).updateOne(
            { userId: LEGACY_TELEGRAM_ID },
            { $set: { "preferences.triggersOptIn": true, updatedAt: now } }
        );
        console.log("users: existing row will be repointed below");
    }

    // ── 2. the identity row ──────────────────────────────────────────────────
    if (!existingIdentity) {
        await db.collection(USER_IDENTITY).insertOne({
            userId: targetUserId,
            channel: "telegram",
            externalId: String(LEGACY_TELEGRAM_ID),
            address: String(LEGACY_TELEGRAM_ID),
            displayName: "Rhythm Panchal",
            isPrimary: true,
            linkedAt: now,
            createdAt: now,
            updatedAt: now,
        });
    }
    console.log(`userIdentity: telegram:${LEGACY_TELEGRAM_ID} → userId ${targetUserId}`);

    // ── 3. repoint every owned row ───────────────────────────────────────────
    for (const name of OWNED_COLLECTIONS) {
        try {
            const res = await db.collection(name).updateMany(
                { userId: LEGACY_TELEGRAM_ID },
                { $set: { userId: targetUserId } }
            );
            if (res.modifiedCount) console.log(`  ${String(res.modifiedCount).padStart(6)}  ${name}`);
        } catch (err) {
            if (err?.code !== 11000) throw err;
            // Only reachable in the repair path: the bot wrote a row under the
            // new id that collides with a legacy row on a unique index — most
            // likely same (userId, date). Merging those needs a human decision,
            // so stop here rather than guess which row survives.
            throw new Error(
                `${name}: a row written under userId ${targetUserId} collides with a legacy row ` +
                `on a unique index. De-duplicate ${name} by hand, then re-run.\n  ${err.message}`
            );
        }
    }

    // ── 4. seed the counter past every id now in use ─────────────────────────
    const maxId = (await db.collection(USERS).find({}, { projection: { userId: 1 } }).toArray())
        .reduce((m, u) => Math.max(m, Number(u.userId) || 0), 0);
    await db.collection(COUNTERS).updateOne(
        { _id: USER_ID_SEQUENCE },
        { $set: { seq: maxId } },
        { upsert: true }
    );
    console.log(`\ncounters.${USER_ID_SEQUENCE}.seq = ${maxId} (next signup gets ${maxId + 1})`);

    console.log(`
=====================================================================
NOW DO THESE, IN THIS ORDER
=====================================================================
1. src/agent/instruction.js — the PROFILE block still tells the model
   "userId (integer): ${LEGACY_TELEGRAM_ID}". Until it says ${targetUserId}, every record
   the LLM writes lands under the old id and is invisible to every read.
   This is the one that silently loses data. Do it first.

2. src/agent/userManager.js — LEGACY_USER is now dead. resolveRoutineTargets
   finds the real row via triggersOptIn. Delete it once routines have fired
   once and you have seen them land.

3. Old triggerJob rows keep actionType "sendMessage" with a baked-in
   payload.chatId. They still fire — the dispatcher keeps that path. New
   reminders use "sendToUser". Nothing to change; just know why both exist.
=====================================================================`);
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error("\nMIGRATION FAILED:", err); process.exit(1); });
