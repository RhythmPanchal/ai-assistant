import { Router } from "express";
import crypto from "crypto";

import { runIdentityMigration } from "./tools/mongo/migrations/001-internal-user-ids.js";

/*
============================= ADMIN ENDPOINTS ==================================
A migration rewrites the owner of every row in the database, so this route is a
standing "rewrite production" button on a public URL. Three things keep it safe,
and removing any one of them makes it dangerous:

  1. It is authenticated with a token derived from a secret already shared by
     this process and whoever is calling. Nothing new has to be provisioned, and
     the secret itself never crosses the wire.
  2. It is dry-run unless ?apply=true, so a mistaken call reports rather than
     writes.
  3. The migrations themselves are idempotent and guard their own preconditions.

This exists so the migration can be run against the deployed database, which is
not reachable from a laptop. Delete the route once 001 has been applied — a
permanent remote-write endpoint is not worth keeping for a one-off.
================================================================================
*/

const MIGRATIONS = {
    "001-internal-user-ids": runIdentityMigration,
};

/**
 * The shared secret is MONGO_DB_URI: any caller entitled to run a migration
 * already knows it, it is guaranteed to be set wherever a migration could run,
 * and hashing means the connection string is never sent anywhere.
 *
 * TELEGRAM_BOT_TOKEN is accepted as a second basis purely so the caller does not
 * have to guess which of two equally-secret values this deployment was given.
 */
function validTokens() {
    return ["MONGO_DB_URI", "TELEGRAM_BOT_TOKEN"]
        .map((name) => process.env[name])
        .filter(Boolean)
        .map((secret) => crypto.createHash("sha256").update(`${secret}:migration`).digest("hex"));
}

function authorised(req) {
    const provided = String(req.get("X-Migration-Token") ?? "");
    const expected = validTokens();
    if (!expected.length || !provided) return false;

    // timingSafeEqual throws on a length mismatch, and every candidate is a
    // fixed-length sha256 hex digest, so compare the length first.
    return expected.some((candidate) =>
        provided.length === candidate.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(candidate))
    );
}

const router = Router();

router.post("/admin/migrations/:name", async (req, res) => {
    if (!authorised(req)) {
        console.warn(`[admin] rejected migration call for "${req.params.name}" — bad or missing token`);
        return res.status(401).json({ error: "unauthorized" });
    }

    const migration = MIGRATIONS[req.params.name];
    if (!migration) {
        return res.status(404).json({ error: `unknown migration`, available: Object.keys(MIGRATIONS) });
    }

    // Opt in explicitly. Anything other than the exact string reports only.
    const apply = req.query.apply === "true";

    try {
        const report = await migration({ apply });
        console.log(`[admin] migration ${req.params.name} -> ${report.status}`);
        return res.json(report);
    } catch (err) {
        console.error(`[admin] migration ${req.params.name} failed:`, err);
        return res.status(500).json({ error: err.message, status: "failed" });
    }
});

export default router;
