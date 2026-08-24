/**
 * Hand-run:  node src/tools/mongo/migrations/cli.js 001 [--apply]
 *
 * Thin wrapper so a migration can be run locally as well as through the admin
 * endpoint. The migration modules themselves stay side-effect free on import —
 * the admin route imports one, and loading a module must never move data.
 */
import "dotenv/config";

import { runIdentityMigration } from "./001-internal-user-ids.js";

const MIGRATIONS = {
    "001": runIdentityMigration,
};

const name = process.argv[2];
const apply = process.argv.includes("--apply");
const migration = MIGRATIONS[name];

if (!migration) {
    console.error(`Unknown migration "${name}". Available: ${Object.keys(MIGRATIONS).join(", ")}`);
    process.exit(1);
}

console.log(apply ? "APPLYING\n" : "DRY RUN — pass --apply to write\n");

try {
    const report = await migration({ apply });

    for (const [collection, count] of Object.entries(report.counts)) {
        console.log(`  ${String(count).padStart(6)}  ${collection}`);
    }
    console.log(`  ${String(report.total).padStart(6)}  TOTAL`);
    console.log(`\ndatabase: ${report.database}   status: ${report.status}   target userId: ${report.targetUserId}`);

    if (report.checklist) {
        console.log("\nNOW DO THESE:\n" + report.checklist.map((c, i) => `${i + 1}. ${c}\n`).join("\n"));
    }
    process.exit(0);
} catch (err) {
    console.error("\nMIGRATION FAILED:", err);
    process.exit(1);
}
