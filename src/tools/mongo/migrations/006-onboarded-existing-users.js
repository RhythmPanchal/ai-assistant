/**
 * Mark everyone already using Rasmalai as onboarded.
 *
 * onboardedAt has been null for every account since the field was added,
 * because there was no onboarding for anyone to finish. It now decides two
 * things: /start runs a REVIEW for someone onboarded and a first-time setup for
 * someone not, and routines can only be switched on for someone onboarded. Left
 * null, the one real user would be welcomed as a stranger, and could never turn
 * a paused routine back on.
 *
 * "Already using" means routines are on, or the notes hold something. Neither is
 * true of an account that only ever said hello — that one should get the real
 * onboarding, welcome included.
 *
 * DRY RUN BY DEFAULT. Stamped with the account's own createdAt, since that is how
 * long they have been using it. The report carries counts and userIds only.
 */
import { getDB } from "../mongoClient.js";
import { USERS, NOTE_SECTIONS } from "../schema/usersSchema.js";

const MIGRATION = "006-onboarded-existing-users";

/** Established and never marked onboarded. `: null` matches a missing field too. */
export function establishedUsersFilter() {
    return {
        onboardedAt: null,
        $or: [
            { "preferences.triggersOptIn": true },
            // A cleared section is stored as null, so only real text counts.
            ...NOTE_SECTIONS.map(({ key }) => ({ [`notes.${key}.text`]: { $type: "string" } })),
        ],
    };
}

/**
 * @param {object}  [options]
 * @param {boolean} [options.apply] false (default) reports only; true writes.
 */
export async function runOnboardedBackfill({ apply = false } = {}) {
    const db = await getDB();
    const report = {
        apply,
        database: db.databaseName,
        status: "pending",
        matched: 0,
        stamped: 0,
        userIds: [],
        steps: [],
    };
    const step = (m) => { report.steps.push(m); console.log(`[migration:${MIGRATION}] ${m}`); };

    const filter = establishedUsersFilter();
    const users = await db.collection(USERS).find(filter, { projection: { userId: 1 } }).toArray();
    report.matched = users.length;
    report.userIds = users.map(u => u.userId);

    if (!users.length) {
        report.status = "nothing-to-do";
        step("no established account is missing onboardedAt");
        return report;
    }

    if (!apply) {
        report.status = "dry-run";
        step(`dry run: would mark ${users.length} account(s) onboarded: ${report.userIds.join(", ")}`);
        return report;
    }

    const now = new Date();
    // A pipeline update, so each account is stamped with its OWN createdAt.
    const result = await db.collection(USERS).updateMany(filter, [
        { $set: { onboardedAt: { $ifNull: ["$createdAt", now] }, updatedAt: now } },
    ]);
    report.stamped = result.modifiedCount;
    report.status = result.modifiedCount ? "applied" : "nothing-to-do";
    step(`marked ${result.modifiedCount} account(s) onboarded: ${report.userIds.join(", ")}`);
    return report;
}

export default runOnboardedBackfill;
