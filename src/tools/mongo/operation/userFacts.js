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

/**
 * Everything the model needs to edit a profile rather than only read one.
 *
 * The rendered block in the system prompt is prose grouped by category and does
 * NOT show keys — deliberately, since keys on every turn are noise for a model
 * that is only reading. But a key is exactly what an UPDATE needs: without it
 * the model cannot tell whether to replace work.status or invent a new slug, and
 * the upsert stops being an upsert.
 *
 * So the keys live here, fetched only when something is about to be written.
 */
export async function getUserContext(userId) {
    const db = await getDB();

    const [facts, vocabulary] = await Promise.all([
        db.collection(USER_FACT)
            .find({ userId }, { projection: { _id: 0, userId: 0, sourceTurn: 0 } })
            .sort({ key: 1 })
            .toArray(),
        getMatchingVocabulary(),
    ]);

    // Which vocabulary entries this user has nothing under. This is the list the
    // enrichment skill works from — "what do I not know yet" is otherwise a
    // subtraction the model has to do in its head, and it does it badly.
    const held = new Set(facts.map(f => f.key));
    const unused = vocabulary.filter(v => !held.has(v.key));

    return { userId, facts, vocabulary, unused };
}

/**
 * Delete facts by key. Returns the keys that were actually removed, so a caller
 * cannot report a deletion that did not happen.
 *
 * A hard delete, unlike the 002 migration's archive. A fact is one sentence the
 * model can be told again, and keeping a shadow copy of something the user asked
 * to be forgotten is the wrong default for personal data.
 */
export async function forgetFacts(userId, keys = []) {
    if (!Number.isInteger(userId)) {
        throw new Error(`[forgetFacts] userId must be an integer, got ${userId}`);
    }
    const list = (Array.isArray(keys) ? keys : [keys])
        .map(k => String(k ?? "").trim().toLowerCase())
        .filter(Boolean);
    if (!list.length) return { removed: [], missing: [] };

    const db = await getDB();
    const removed = [];
    const missing = [];

    for (const key of list) {
        const res = await db.collection(USER_FACT).deleteOne({ userId, key });
        (res.deletedCount ? removed : missing).push(key);
    }
    return { removed, missing };
}

/**
 * Add a key to the shared vocabulary by hand.
 *
 * rememberFacts already mints an unrecognised key as a side effect of using it,
 * which covers the normal case. This exists for the other one: naming a concept
 * before there is a fact to file under it, so the enrichment skill knows to ask.
 */
export async function addFactKey(key, description, userId = null) {
    const slug = String(key ?? "").trim().toLowerCase();
    if (!KEY_PATTERN.test(slug)) {
        return { ok: false, key, reason: 'key must look like "work.status" — lowercase, dot-separated' };
    }
    if (!String(description ?? "").trim()) {
        return { ok: false, key: slug, reason: "description is required — it is the instruction the extraction model reads" };
    }

    const db = await getDB();
    const now = new Date();
    const res = await db.collection(FACT_KEY).updateOne(
        { key: slug },
        {
            $set: { description: String(description).trim(), updatedAt: now },
            $setOnInsert: {
                origin: "emergent",
                usageCount: 0,
                firstSeenFrom: userId,
                promotedAt: null,
                createdAt: now,
            },
        },
        { upsert: true }
    );
    return { ok: true, key: slug, action: res.upsertedCount ? "created" : "updated" };
}

/**
 * Remove a key from the vocabulary.
 *
 * Refuses while any user still holds a fact under it — deleting the key would
 * leave those facts referring to a definition that no longer exists, and the
 * next extraction pass would mint the same slug back with a worse description.
 * Core keys are refused outright; the reviewed spine is not editable at runtime.
 */
export async function removeFactKey(key) {
    const slug = String(key ?? "").trim().toLowerCase();
    const db = await getDB();

    const entry = await db.collection(FACT_KEY).findOne({ key: slug });
    if (!entry) return { ok: false, key: slug, reason: "no such key" };
    if (entry.origin === "core") {
        return { ok: false, key: slug, reason: "core keys are part of the reviewed spine and cannot be removed at runtime" };
    }

    const inUse = await db.collection(USER_FACT).countDocuments({ key: slug });
    if (inUse) {
        return { ok: false, key: slug, reason: `${inUse} fact(s) still use this key — remove those first` };
    }

    await db.collection(FACT_KEY).deleteOne({ key: slug });
    return { ok: true, key: slug, action: "removed" };
}
