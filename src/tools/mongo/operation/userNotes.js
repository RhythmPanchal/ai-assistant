import { getDB } from "../mongoClient.js";
import {
    USERS, NOTE_SECTIONS, NOTE_SECTION_LIMIT, NUDGEABLE_SECTIONS, NUDGE_COOLDOWN_DAYS,
} from "../schema/usersSchema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The model's notes on a person — one short paragraph per fixed section, stored
 * on their users document.
 *
 * This replaced two collections of structure (typed goals, a sampled routine)
 * and the fact store before them. The agent reads a profile on every turn and
 * edits it now and then; nothing ever needed to query it. Prose it rewrites is
 * the shape that job actually has.
 */

const SECTION_KEYS = NOTE_SECTIONS.map(s => s.key);

/**
 * Decide whether a write is acceptable, and normalise it. Pure, so the rules
 * that keep the notes from rotting can be pinned without a database.
 *
 * Whitespace collapses to single spaces. Each section renders as one line of the
 * system prompt, and a newline inside a note is the only way its text could
 * start a line that looks like the prompt's own structure — a row of "=" and a
 * heading that reads as an instruction. The user's own words end up in here, so
 * that is worth closing off rather than trusting.
 */
export function validateNoteWrite(section, text) {
    if (!SECTION_KEYS.includes(section)) {
        return { ok: false, reason: `section must be one of ${SECTION_KEYS.join(", ")}` };
    }
    if (typeof text !== "string") {
        return { ok: false, reason: "text must be a string — send an empty string to clear the section" };
    }

    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length > NOTE_SECTION_LIMIT) {
        return {
            ok: false,
            reason:
                `that is ${clean.length} characters and a section holds at most ${NOTE_SECTION_LIMIT}. ` +
                `Rewrite it shorter: merge what overlaps and drop what is no longer true.`,
        };
    }
    return { ok: true, section, text: clean };
}

/**
 * Replace one section of a user's notes.
 *
 * Replace, never append — appending is how notes grow until they are useless.
 * The replaced text is kept as previousText, one level deep, so a rewrite that
 * silently drops a goal can still be recovered.
 *
 * Refusals are RETURNED, not thrown: the model has to see the reason to rewrite
 * shorter, and a thrown error reaches it as "crashed", which reads like a fault
 * to retry rather than a limit to respect.
 *
 * An unchanged section is not written. Re-saving identical text would overwrite
 * previousText with itself and lose the one level of history it exists to keep.
 */
export async function updateNoteSection(userId, section, text, now = new Date()) {
    if (!Number.isInteger(userId)) {
        throw new Error(`[updateNoteSection] userId must be an integer, got ${userId}`);
    }

    const check = validateNoteWrite(section, text);
    if (!check.ok) return { ok: false, section, reason: check.reason };

    const db = await getDB();
    const users = db.collection(USERS);

    const current = await users.findOne({ userId }, { projection: { [`notes.${section}`]: 1 } });
    if (!current) {
        // The identity layer creates the users row on first contact, so this is
        // a broken account, not a new one. Upserting here would mint a users row
        // with no name and no createdAt, which the schema requires.
        throw new Error(`[updateNoteSection] no users row for userId ${userId}`);
    }

    const before = current.notes?.[section]?.text ?? null;
    const after = check.text || null;

    if (before === after) return { ok: true, section, action: "unchanged" };

    // Read-then-write rather than one pipeline update. Two parallel writes to the
    // SAME section in one step could both read the same `before` and leave
    // previousText one version stale; turns are serial per user and a model
    // rewriting one section twice in a single step is not a real pattern.
    await users.updateOne(
        { userId },
        {
            $set: {
                [`notes.${section}.text`]: after,
                [`notes.${section}.previousText`]: before,
                [`notes.${section}.updatedAt`]: now,
                updatedAt: now,
            },
        }
    );

    const action = after === null ? "cleared" : before === null ? "created" : "updated";
    return { ok: true, section, action, length: after?.length ?? 0 };
}

/**
 * Claim this week's chance for a routine to raise a goal unprompted. Returns
 * true for exactly one caller per cooldown window, false for everyone else.
 *
 * One atomic findOneAndUpdate, so the rule holds under any interleaving: both
 * routines can be open at once (the night flow runs until 10:00, the morning
 * one opens at 09:00), and two turns claiming together still produce one nudge.
 *
 * Nothing is claimed when there is nothing to raise. A user whose notes hold no
 * habit or goal keeps their window — otherwise the first week of someone's notes
 * would be spent on a claim with nothing behind it.
 *
 * The window is spent when the chance is GIVEN, not when the model uses it. The
 * model deciding nothing is slipping is still a week without a nudge, which is
 * the conservative reading of "rarely", and it means the model never has to
 * report back for the cooldown to hold.
 */
export async function claimNudge(userId, now = new Date()) {
    if (!Number.isInteger(userId)) {
        throw new Error(`[claimNudge] userId must be an integer, got ${userId}`);
    }

    const cutoff = new Date(now.getTime() - NUDGE_COOLDOWN_DAYS * DAY_MS);
    const db = await getDB();

    const claimed = await db.collection(USERS).findOneAndUpdate(
        {
            userId,
            $and: [
                // `: null` matches a missing field as well as a null one.
                { $or: [{ "notes.lastNudgedAt": null }, { "notes.lastNudgedAt": { $lte: cutoff } }] },
                // A cleared section is stored as null, so a string means real text.
                { $or: NUDGEABLE_SECTIONS.map(section => ({ [`notes.${section}.text`]: { $type: "string" } })) },
            ],
        },
        { $set: { "notes.lastNudgedAt": now } },
        { projection: { _id: 1 } }
    );

    return Boolean(claimed);
}
