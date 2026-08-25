/**
 * Remove every account except the owner's, then move the owner onto userId 1.
 *
 * Run after 001. Reported by GET / like every boot migration.
 *
 * NOTHING IS HARD DELETED. Every row is copied into `archivedRows` before it is
 * removed from the live collection, keyed by migration and owner, so a purge
 * that turns out to be wrong is a restore rather than a loss. That archive is
 * also the record of what was removed — 001's report named the owners, but not
 * what they held.
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
import { USER_FACT } from "../schema/userFactSchema.js";
import { USER_IDENTITY } from "../schema/userIdentitySchema.js";
import { USER_SCHEDULE } from "../schema/userScheduleSchema.js";
import { USERS } from "../schema/usersSchema.js";
import { LEGACY_TELEGRAM_ID } from "./001-internal-user-ids.js";

export const ARCHIVE = "archivedRows";

/**
 * Exactly the owners 001 reported, listed rather than discovered.
 *
 * Discovery would be shorter and worse: anyone who messages the bot between
 * writing this and the deploy that runs it would be swept up by a query, and
 * silently. A literal list can only ever affect the six accounts that were
 * actually reviewed.
 *
 * The five long values are raw Telegram ids that never got an internal id. The
 * 1 is an internal id the identity layer allocated to one of them during the
 * window between the identity deploy and 001 — which is why it held the id the
 * owner was supposed to get.
 */
const PURGE_OWNERS = [1021482398, 1129292622, 6186608759, 7243525898, 8979426580, 1];

const FINAL_USER_ID = 1;

/** Every collection keyed by userId, including the two added after 001. */
const OWNED_COLLECTIONS = [
    ACTIVE_FLOWS, CHAT_HISTORY, CONNECTION, DIET_REGISTER, EXPENSE_REGISTER,
    TASK_CALENDAR, TASK_REGISTER, TRIGGER_JOB, USER_SCHEDULE, USERS, USER_FACT,
    USER_IDENTITY, "llmUsage",
];

export async function runPurgeAndRenumber({ apply = false } = {}) {
    const db = await getDB();
    const report = {
        apply,
        database: db.databaseName,
        status: "pending",
        purgeOwners: PURGE_OWNERS,
        archived: {},
        renumbered: {},
        steps: [],
    };
    const step = (m) => { report.steps.push(m); console.log(`[migration:002] ${m}`); };

    // ── the owner's current id comes from their identity, never a constant ────
    const ownerIdentity = await db.collection(USER_IDENTITY)
        .findOne({ channel: "telegram", externalId: String(LEGACY_TELEGRAM_ID) });

    if (!ownerIdentity) {
        report.status = "blocked";
        step(`no identity for telegram:${LEGACY_TELEGRAM_ID} — 001 has not run; refusing to purge`);
        return report;
    }

    const ownerId = ownerIdentity.userId;
    report.ownerId = ownerId;
    report.finalUserId = FINAL_USER_ID;

    // Guard against a list that would delete the person we are keeping. Cheap,
    // and the one mistake in this file that could not be undone from the archive
    // without also undoing the renumber.
    if (PURGE_OWNERS.includes(ownerId)) {
        throw new Error(`refusing to run: owner id ${ownerId} appears in PURGE_OWNERS`);
    }

    if (!apply) {
        for (const owner of PURGE_OWNERS) {
            for (const name of OWNED_COLLECTIONS) {
                const n = await db.collection(name).countDocuments({ userId: owner });
                if (n) report.archived[`${name}:${owner}`] = n;
            }
        }
        report.status = "dry-run";
        step(`dry run: would archive and remove ${Object.values(report.archived).reduce((a, b) => a + b, 0)} rows`);
        return report;
    }

    const now = new Date();

    // ── 1. archive, then remove ──────────────────────────────────────────────
    for (const owner of PURGE_OWNERS) {
        for (const name of OWNED_COLLECTIONS) {
            const rows = await db.collection(name).find({ userId: owner }).toArray();
            if (!rows.length) continue;

            await db.collection(ARCHIVE).insertMany(
                rows.map((doc) => ({
                    migration: "002-purge-and-renumber",
                    sourceCollection: name,
                    ownerId: owner,
                    archivedAt: now,
                    doc,
                })),
                { ordered: false }
            );

            const res = await db.collection(name).deleteMany({ userId: owner });
            report.archived[`${name}:${owner}`] = res.deletedCount;
        }
    }
    const totalArchived = Object.values(report.archived).reduce((a, b) => a + b, 0);
    step(`archived and removed ${totalArchived} rows across ${PURGE_OWNERS.length} owners`);

    // ── 2. move the owner onto the now-free id ───────────────────────────────
    if (ownerId === FINAL_USER_ID) {
        step(`owner already holds userId ${FINAL_USER_ID}`);
    } else {
        const blocker = await db.collection(USERS).findOne({ userId: FINAL_USER_ID });
        if (blocker) {
            throw new Error(
                `userId ${FINAL_USER_ID} is still held after the purge — it belongs to an account ` +
                `not in PURGE_OWNERS. Review before re-running.`
            );
        }

        for (const name of OWNED_COLLECTIONS) {
            const res = await db.collection(name).updateMany(
                { userId: ownerId },
                { $set: { userId: FINAL_USER_ID } }
            );
            if (res.modifiedCount) report.renumbered[name] = res.modifiedCount;
        }
        step(`renumbered owner ${ownerId} → ${FINAL_USER_ID}`);
    }

    // ── 3. the counter follows the data ──────────────────────────────────────
    // Only the owner remains, so the next signup is the id after theirs.
    await db.collection(COUNTERS).updateOne(
        { _id: USER_ID_SEQUENCE },
        { $set: { seq: FINAL_USER_ID } },
        { upsert: true }
    );
    step(`counters.${USER_ID_SEQUENCE}.seq = ${FINAL_USER_ID} (next signup gets ${FINAL_USER_ID + 1})`);

    report.status = "applied";
    report.restoreHint =
        `Every removed row is in "${ARCHIVE}" under migration "002-purge-and-renumber", with its ` +
        `original collection and owner id. Restoring is an insert back per sourceCollection.`;
    return report;
}
