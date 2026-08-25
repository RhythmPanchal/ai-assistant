/**
 * Repoint every row owned by the original Telegram-chat-id user onto an internal
 * incremental userId, and record the Telegram id as an identity row.
 *
 * Two ways in:
 *   node src/tools/mongo/migrations/001-internal-user-ids.js [--apply]
 *   POST /admin/migrations/001-internal-user-ids[?apply=true]   (adminRestAPI.js)
 *
 * DRY RUN BY DEFAULT in both. Without apply it only reports what it would change.
 *
 * RUN THIS BEFORE STARTING THE BOT on the identity-layer code. If the bot gets
 * here first, the legacy user's next message finds no identity, allocates a
 * fresh id, and opens an empty profile while every existing row still sits under
 * the old id. That is repairable — the code below adopts the id the bot minted
 * and repoints onto it — but the clean path is to run this first.
 *
 * Read the checklist in the result. Two code changes have to follow it.
 */
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

export const LEGACY_TELEGRAM_ID = 1136575387;

/**
 * Internal ids come from a counter starting at 1; a raw Telegram id is nine or
 * ten digits. Anything in users above this ceiling is therefore a pre-split row
 * that has not been migrated yet, and must not be mistaken for an allocated id —
 * treating one as the high-water mark would push the counter into the billions
 * and make every later signup unreadable.
 */
const INTERNAL_ID_CEILING = 1_000_000;

/**
 * Pick a free internal id for the legacy user.
 *
 * This used to be a hardcoded 1, which failed on the first real run: the bot had
 * been live on the identity layer for several hours, a second Telegram account
 * had messaged it, and resolveUserByChannel had already handed that person id 1.
 * The legacy user is not entitled to id 1 — only to an id nobody else holds.
 *
 * Safe without a lock because this runs at boot, before the Telegram loop starts
 * and therefore before anything else can allocate.
 */
async function pickFreeUserId(db) {
    const taken = new Set(
        (await db.collection(USERS).distinct("userId")).map(Number).filter(Number.isFinite)
    );
    const counter = await db.collection(COUNTERS).findOne({ _id: USER_ID_SEQUENCE });

    let candidate = Math.max(Number(counter?.seq) || 0, 0) + 1;
    while (taken.has(candidate)) candidate++;
    return candidate;
}

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

/**
 * @param {object}  [options]
 * @param {boolean} [options.apply] false (default) reports only; true writes.
 * @returns {Promise<object>} structured report, safe to serialise to JSON
 */
export async function runIdentityMigration({ apply = false } = {}) {
    const db = await getDB();
    const report = {
        apply,
        database: db.databaseName,
        legacyTelegramId: LEGACY_TELEGRAM_ID,
        status: "pending",
        counts: {},
        total: 0,
        steps: [],
    };
    const step = (m) => { report.steps.push(m); console.log(`[migration:001] ${m}`); };

    // ── where are we? ────────────────────────────────────────────────────────
    // An existing identity does NOT mean the migration ran. It far more likely
    // means the bot booted first and auto-allocated an id for the legacy user,
    // leaving a stub profile alongside untouched legacy rows. Repair that state
    // rather than refusing: adopt the id the bot minted.
    const existingIdentity = await db.collection(USER_IDENTITY)
        .findOne({ channel: "telegram", externalId: String(LEGACY_TELEGRAM_ID) });
    const targetUserId = existingIdentity?.userId ?? await pickFreeUserId(db);
    report.targetUserId = targetUserId;
    report.adoptedExistingIdentity = Boolean(existingIdentity);

    if (existingIdentity) {
        step(`identity exists — the bot allocated userId ${targetUserId} before this ran; repointing onto it`);
    } else {
        step(`allocated userId ${targetUserId} for telegram:${LEGACY_TELEGRAM_ID}`);
    }

    // ── report ───────────────────────────────────────────────────────────────
    for (const name of OWNED_COLLECTIONS) {
        report.counts[name] = await db.collection(name).countDocuments({ userId: LEGACY_TELEGRAM_ID });
        report.total += report.counts[name];
    }

    report.otherOwners = await db.collection(CHAT_HISTORY)
        .distinct("userId", { userId: { $ne: LEGACY_TELEGRAM_ID } });
    if (report.otherOwners.length) {
        step(`chatHistory also holds rows for ${report.otherOwners.join(", ")} — they need their own pass`);
    }

    if (report.total === 0) {
        report.status = "nothing-to-do";
        step("no rows remain under the legacy id — already migrated");
        return report;
    }

    if (!apply) {
        report.status = "dry-run";
        step(`dry run: ${report.total} rows would move to userId ${targetUserId}`);
        return report;
    }

    const now = new Date();

    // ── 1. the users row ─────────────────────────────────────────────────────
    const legacyProfile = await db.collection(USERS).findOne({ userId: LEGACY_TELEGRAM_ID });

    if (existingIdentity && legacyProfile) {
        // Two rows for one person: the stub the bot created under targetUserId,
        // and the real legacy profile. Repointing the legacy row would violate
        // the unique index on userId, so the empty stub goes first.
        const removed = await db.collection(USERS).deleteOne({ userId: targetUserId });
        if (removed.deletedCount) step(`users: removed the empty stub row for userId ${targetUserId}`);
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
        step(`users: created row for userId ${targetUserId}`);
    } else {
        await db.collection(USERS).updateOne(
            { userId: LEGACY_TELEGRAM_ID },
            { $set: { "preferences.triggersOptIn": true, updatedAt: now } }
        );
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
    step(`userIdentity: telegram:${LEGACY_TELEGRAM_ID} → userId ${targetUserId}`);

    // ── 3. repoint every owned row ───────────────────────────────────────────
    report.moved = {};
    for (const name of OWNED_COLLECTIONS) {
        try {
            const res = await db.collection(name).updateMany(
                { userId: LEGACY_TELEGRAM_ID },
                { $set: { userId: targetUserId } }
            );
            if (res.modifiedCount) report.moved[name] = res.modifiedCount;
        } catch (err) {
            if (err?.code !== 11000) throw err;
            // Only reachable in the repair path: the bot wrote a row under the
            // new id that collides with a legacy row on a unique index — most
            // likely same (userId, date). Merging those needs a human decision,
            // so stop rather than guess which row survives.
            throw new Error(
                `${name}: a row written under userId ${targetUserId} collides with a legacy row ` +
                `on a unique index. De-duplicate ${name} by hand, then re-run. ${err.message}`
            );
        }
    }

    // ── 4. seed the counter past every ALLOCATED id ──────────────────────────
    // Only ids below the ceiling count. Another user may still be sitting in
    // users under their raw Telegram id awaiting their own pass; taking that as
    // the high-water mark would set seq to ten digits and every later signup
    // would get an id indistinguishable from a chat id — reintroducing exactly
    // the confusion this migration exists to end.
    const maxId = (await db.collection(USERS).distinct("userId"))
        .map(Number)
        .filter(n => Number.isFinite(n) && n < INTERNAL_ID_CEILING)
        .reduce((m, n) => Math.max(m, n), 0);

    await db.collection(COUNTERS).updateOne(
        { _id: USER_ID_SEQUENCE },
        { $set: { seq: maxId } },
        { upsert: true }
    );
    step(`counters.${USER_ID_SEQUENCE}.seq = ${maxId} (next signup gets ${maxId + 1})`);

    report.status = "applied";
    report.checklist = [
        `src/agent/instruction.js — nothing to do. WHO YOU ARE HELPING is rendered per turn by ` +
        `userProfileKnowledge and already emits the resolved userId. Confirm on a real turn that ` +
        `it reads "userId (integer): ${targetUserId}".`,

        `src/agent/userManager.js — LEGACY_USER is now dead. resolveRoutineTargets finds the real ` +
        `row via triggersOptIn. Delete it once routines have fired and you have seen them land.`,

        `Old triggerJob rows keep actionType "sendMessage" with a baked-in payload.chatId. They ` +
        `still fire — the dispatcher keeps that path. New reminders use "sendToUser".`,
    ];
    return report;
}
