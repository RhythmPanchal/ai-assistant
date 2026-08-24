import { getDB } from "../mongoClient.js";
import { USER_FACT } from "../schema/userFactSchema.js";
import {
    FACT_KEY, CORE_FACT_KEYS, KEY_PATTERN, PROMOTION_THRESHOLD, VOCABULARY_LIMIT,
} from "../schema/factKeySchema.js";

/**
 * Reads and writes for the user-fact store.
 *
 * The vocabulary is data rather than a constant because a key discovered from
 * one user should become available for the next, and code cannot be written at
 * runtime. CORE_FACT_KEYS seeds a reviewed spine at boot; everything past it is
 * minted here from real conversations.
 */

/**
 * Materialise the core spine into factKey. Idempotent, and safe to run on every
 * boot — the same shape as ensureIndexes.
 *
 * description is refreshed on each run so editing the spine in code updates the
 * text the extraction model is given. usageCount and firstSeenFrom are NOT, or
 * a deploy would erase the evidence promotion depends on.
 */
export async function ensureFactKeys() {
    const db = await getDB();
    const now = new Date();
    let seeded = 0;

    for (const [key, description] of Object.entries(CORE_FACT_KEYS)) {
        const res = await db.collection(FACT_KEY).updateOne(
            { key },
            {
                // origin in $set, not $setOnInsert: adding an emergent key to the
                // spine in code is how it gets promoted to core.
                $set: { description, origin: "core", updatedAt: now },
                $setOnInsert: {
                    usageCount: 0,
                    firstSeenFrom: null,
                    // Core keys are in the asking vocabulary by definition.
                    promotedAt: now,
                    createdAt: now,
                },
            },
            { upsert: true }
        );
        if (res.upsertedCount) seeded++;
    }

    console.log(`[factKeys] ${Object.keys(CORE_FACT_KEYS).length} core keys ensured (${seeded} new)`);
}

/**
 * Keys the extraction pass may MATCH against — every key, core and emergent.
 *
 * Deliberately broad: a key the model cannot see is a key it will reinvent under
 * a different name, which is the drift the registry exists to prevent. Capped by
 * usageCount so the prompt cost stays fixed rather than growing with every key
 * ever minted.
 */
export async function getMatchingVocabulary(limit = VOCABULARY_LIMIT) {
    const db = await getDB();
    const rows = await db.collection(FACT_KEY)
        .find({}, { projection: { key: 1, description: 1, _id: 0 } })
        .sort({ usageCount: -1, key: 1 })
        .limit(limit)
        .toArray();
    return rows;
}

/**
 * Keys the onboarding flow may ASK about — core plus emergent keys that enough
 * distinct users turned out to have.
 *
 * Deliberately narrow: one user mentioning their CA exams is not a reason to
 * interrogate everyone about certifications.
 */
export async function getAskingVocabulary() {
    const db = await getDB();
    return db.collection(FACT_KEY)
        .find({ promotedAt: { $ne: null } }, { projection: { key: 1, description: 1, _id: 0 } })
        .sort({ key: 1 })
        .toArray();
}

/**
 * Record a key we have not seen before. Emergent keys are visible to MATCHING
 * immediately — the count can only rise if other users' extraction passes can
 * see the key to reuse it.
 */
async function mintFactKey(key, description, userId, now) {
    const db = await getDB();
    await db.collection(FACT_KEY).updateOne(
        { key },
        {
            $set: { updatedAt: now },
            $setOnInsert: {
                description: description || `Minted from a conversation with user ${userId}.`,
                origin: "emergent",
                usageCount: 0,
                firstSeenFrom: userId,
                promotedAt: null,
                createdAt: now,
            },
        },
        { upsert: true }
    );
}

/**
 * Count this key against promotion, and promote once enough DISTINCT users hold
 * it. Called only when a user gains a key they did not already have, so one
 * person restating the same thing weekly cannot promote it alone.
 */
async function countKeyUsage(key, now) {
    const db = await getDB();
    const updated = await db.collection(FACT_KEY).findOneAndUpdate(
        { key },
        { $inc: { usageCount: 1 }, $set: { updatedAt: now } },
        { returnDocument: "after" }
    );
    if (!updated) return;

    if (!updated.promotedAt && updated.usageCount >= PROMOTION_THRESHOLD) {
        await db.collection(FACT_KEY).updateOne({ key }, { $set: { promotedAt: now } });
        console.log(`[factKeys] promoted "${key}" — ${updated.usageCount} users`);
    }
}

/**
 * Validate and normalise one incoming fact. Pure — no database — so the
 * rejection rules can be tested without writing fixture rows into a live
 * collection, and so a malformed batch is caught before we open a connection.
 */
export function normalizeFact(incoming) {
    const raw = incoming?.key;
    const key = String(raw ?? "").trim().toLowerCase();
    const text = String(incoming?.fact ?? "").trim();

    if (!KEY_PATTERN.test(key)) {
        return {
            ok: false,
            key: raw,
            reason: 'key must look like "work.status" — lowercase letters and digits, dot-separated, at least two parts',
        };
    }
    if (!text) return { ok: false, key, reason: "fact text is empty" };

    return { ok: true, key, text };
}

/**
 * Upsert facts for one user. Returns a per-fact report so a caller — and the
 * model, through the tool result — can see what was rejected and why.
 *
 * The upsert on (userId, key) is the point: a second write to work.status
 * REPLACES the first. Appending would leave the prompt asserting that the user
 * is simultaneously job hunting and employed.
 */
export async function rememberFacts(userId, facts = []) {
    if (!Number.isInteger(userId)) {
        throw new Error(`[rememberFacts] userId must be an integer, got ${userId}`);
    }
    const list = Array.isArray(facts) ? facts : [facts];
    if (!list.length) return { saved: [], rejected: [] };

    const db = await getDB();
    const collection = db.collection(USER_FACT);
    const now = new Date();

    const saved = [];
    const rejected = [];

    for (const incoming of list) {
        const check = normalizeFact(incoming);
        if (!check.ok) {
            rejected.push({ key: check.key, reason: check.reason });
            continue;
        }
        const { key, text } = check;

        const existing = await collection.findOne({ userId, key });

        // Unchanged text is not a write. Rewriting it would burn previousValue —
        // the one level of history that lets the agent say "last I knew…".
        if (existing && existing.fact === text) {
            saved.push({ key, action: "unchanged" });
            continue;
        }

        const known = await db.collection(FACT_KEY).findOne({ key }, { projection: { _id: 1 } });
        if (!known) await mintFactKey(key, incoming?.description, userId, now);

        const confidence = incoming?.confidence === "inferred" ? "inferred" : "stated";

        const doc = {
            fact: text,
            category: incoming?.category ?? key.split(".")[0],
            stability: incoming?.stability === "temporary" ? "temporary" : "stable",
            // An inference that overwrites something the user stated is NOT
            // silently promoted to fact: it keeps confidence "inferred", so the
            // rendered block marks it [unconfirmed] and the model will not assert
            // it flatly. That visibility is what makes the overwrite safe.
            confidence,
            expiresAt: incoming?.expiresAt ? new Date(incoming.expiresAt) : null,
            sourceTurn: incoming?.sourceTurn ?? null,
            updatedAt: now,
        };

        if (existing) {
            doc.previousValue = existing.fact;
            doc.previousAt = now;
        }

        await collection.updateOne(
            { userId, key },
            { $set: doc, $setOnInsert: { userId, key, createdAt: now } },
            { upsert: true }
        );

        // Only when the USER gains the key, so promotion counts distinct people.
        if (!existing) await countKeyUsage(key, now);

        saved.push({ key, action: existing ? "updated" : "created" });
    }

    return { saved, rejected };
}
