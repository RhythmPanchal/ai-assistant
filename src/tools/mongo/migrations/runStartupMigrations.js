import { getDB } from "../mongoClient.js";
import { runIdentityMigration } from "./001-internal-user-ids.js";
import { runPurgeAndRenumber } from "./002-purge-and-renumber.js";

/**
 * Run pending data migrations at boot, before anything can read or write the
 * data they move.
 *
 * This replaced an authenticated admin endpoint. The deployed database is not
 * reachable from a laptop — the office network intercepts enough that even the
 * Telegram API returns a proxy block page — so the migration has to be triggered
 * from inside the service. A deploy is already that trigger, and it has none of
 * the downsides: no public URL that rewrites every row, no token to hold, and
 * nothing to remember to delete afterwards.
 *
 * Ordering matters. This runs after ensureIndexes, because the repointing writes
 * depend on the unique indexes existing, and before the Telegram loop starts,
 * because the identity layer would otherwise allocate a fresh id for the legacy
 * user and leave their rows stranded under the old one.
 */

export const MIGRATION_LEDGER = "migrations";

// Order matters and is the order of this array. 002 reads the identity row 001
// writes, and refuses to run rather than guess if it is missing.
const PENDING = [
    { name: "001-internal-user-ids", run: runIdentityMigration },
    { name: "002-purge-and-renumber", run: runPurgeAndRenumber },
];

/**
 * Last result per migration, for the health route to report. Held in memory
 * rather than read per request — it is written once at boot and Render polls
 * the health endpoint often enough that a database round trip per check would
 * be pure waste.
 */
export const migrationStatus = {};

export default async function runStartupMigrations() {
    let db;
    try {
        db = await getDB();
    } catch (err) {
        console.error("[migrations] cannot reach the database, skipping:", err.message);
        return migrationStatus;
    }

    const ledger = db.collection(MIGRATION_LEDGER);

    for (const { name, run } of PENDING) {
        try {
            // The ledger is what keeps this off the boot path forever. The
            // migrations are idempotent anyway, but re-scanning ten collections
            // on every restart to learn there is nothing to do is wasted work.
            const previous = await ledger.findOne({ _id: name });
            if (previous?.status === "applied" || previous?.status === "nothing-to-do") {
                migrationStatus[name] = { status: previous.status, ranAt: previous.ranAt, skipped: true };
                console.log(`[migrations] ${name}: already ${previous.status}, skipping`);
                continue;
            }

            console.log(`[migrations] ${name}: running`);
            const report = await run({ apply: true });
            const ranAt = new Date();

            await ledger.updateOne(
                { _id: name },
                { $set: { status: report.status, ranAt, report } },
                { upsert: true }
            );

            // The whole report, minus the narration. Naming 001's fields here
            // meant 002 reported `moved: null` and an empty owner list while it
            // had in fact archived 36 rows and renumbered 568 — a readout that
            // looked like a no-op after a migration that did the most
            // consequential thing in this codebase. A per-migration shape cannot
            // be right for the next migration, so pass through whatever it
            // returns and let each one decide what is worth saying.
            const { steps, ...summary } = report;
            migrationStatus[name] = { ...summary, ranAt: ranAt.toISOString() };
            console.log(`[migrations] ${name}: ${report.status}`);
        } catch (err) {
            // A failed migration must not stop the bot from starting. The same
            // reasoning as ensureIndexes: a broken data move is worth reporting
            // loudly and fixing deliberately, not worth taking the service down
            // over. The ledger is left unset so the next boot retries.
            migrationStatus[name] = { status: "failed", error: err.message };
            console.error(`[migrations] ${name} FAILED — will retry next boot:`, err);
        }
    }

    return migrationStatus;
}
