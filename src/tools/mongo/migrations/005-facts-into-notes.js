/**
 * Copy every user's stored facts into the notes on their users document.
 *
 * The notes replace the fact store as the durable layer of what the agent knows
 * about a person. Without this, the first deploy that renders notes would show
 * the model an empty profile for everyone who has already told it who they are.
 *
 * DRY RUN BY DEFAULT. runStartupMigrations passes apply: true at boot.
 *
 * Three properties make it safe to run at any time, as often as it likes:
 *
 *  - NOTHING IS DELETED. userFact and factKey are left exactly as they are, as
 *    the backup of what was copied. Dropping them is a separate, deliberate
 *    decision for later, once the notes have been seen to hold up.
 *  - A SECTION THAT ALREADY HAS NOTES IS NEVER OVERWRITTEN. The write is filtered
 *    on the section being empty, so anything the model wrote since wins, and a
 *    second run finds nothing left to do.
 *  - THE REPORT CARRIES NO CONTENT. It is stored in the migrations ledger and
 *    served on GET /, so it holds section names and lengths only — never a word
 *    of what anyone said about themselves.
 */
import { getDB } from "../mongoClient.js";
import { USERS, NOTE_SECTION_LIMIT } from "../schema/usersSchema.js";
import { USER_FACT } from "../schema/userFactSchema.js";

const MIGRATION = "005-facts-into-notes";

/**
 * Which notes section a fact belongs in.
 *
 * Almost everything is `about` — identity, location, work, money, health and
 * people all describe who someone is. The exceptions are the three fact
 * namespaces that have a dedicated section now:
 *
 *  - routine.*   → routine
 *  - style.*     → behaviour: "how they want to be spoken to" is exactly what
 *                  that section holds
 *  - money.goals → longTermGoals: "what they are saving for" was always a goal
 *                  filed as a fact, for want of anywhere better to put it
 *
 * `category` wins over the key's namespace when set, the same precedence the old
 * profile renderer used.
 */
export function sectionForFact(fact) {
    const key = String(fact?.key ?? "");
    if (key === "money.goals") return "longTermGoals";

    const namespace = fact?.category || key.split(".")[0];
    if (namespace === "routine") return "routine";
    if (namespace === "style") return "behaviour";
    return "about";
}

/**
 * Turn a user's fact rows into section text. Pure.
 *
 * Expired facts are left behind — the old renderer had already stopped showing
 * them, so copying one would resurrect a belief the model had been told to drop.
 *
 * The two marks the old block carried survive as plain words, because notes
 * have no fields for them: a temporary fact "may have changed", an inferred one
 * is "unconfirmed". The model will fold those away the next time it rewrites
 * the section, which is the right time for them to go.
 *
 * `sectionOf` is the filing rule — 007 files the same facts by key alone.
 */
export function factsToNotes(facts, now = Date.now(), sectionOf = sectionForFact) {
    const live = (facts || [])
        .filter(f => typeof f?.fact === "string" && f.fact.trim())
        .filter(f => !(f.expiresAt && new Date(f.expiresAt).getTime() <= now))
        // Key order, so the same facts always produce the same text.
        .sort((a, b) => String(a.key).localeCompare(String(b.key)));

    const bySection = {};
    for (const fact of live) {
        let sentence = fact.fact.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");

        const marks = [];
        if (fact.stability === "temporary") marks.push("may have changed");
        if (fact.confidence === "inferred") marks.push("unconfirmed");
        sentence += marks.length ? ` (${marks.join(", ")}).` : ".";

        (bySection[sectionOf(fact)] ??= []).push(sentence);
    }

    return Object.fromEntries(Object.entries(bySection).map(([section, lines]) => [section, lines.join(" ")]));
}

/**
 * @param {object}  [options]
 * @param {boolean} [options.apply] false (default) reports only; true writes.
 */
export async function runFactsIntoNotes({ apply = false } = {}) {
    const db = await getDB();
    const now = new Date();
    const report = {
        apply,
        database: db.databaseName,
        status: "pending",
        factsRead: 0,
        factsExpired: 0,
        written: 0,
        users: [],
        orphans: [],
        steps: [],
    };
    const step = (m) => { report.steps.push(m); console.log(`[migration:${MIGRATION}] ${m}`); };

    // distinct on a collection that was never created returns [], which is the
    // correct answer for a database that never had facts.
    const owners = await db.collection(USER_FACT).distinct("userId");
    if (!owners.length) {
        report.status = "nothing-to-do";
        step("no stored facts to copy");
        return report;
    }

    for (const userId of owners) {
        const facts = await db.collection(USER_FACT).find({ userId }).toArray();
        report.factsRead += facts.length;
        report.factsExpired += facts.filter(f => f.expiresAt && new Date(f.expiresAt).getTime() <= now.getTime()).length;

        const profile = await db.collection(USERS).findOne({ userId }, { projection: { notes: 1 } });
        if (!profile) {
            // Facts for someone with no users row — the accounts 002 purged left
            // theirs behind. There is nowhere to put them, and inventing a users
            // row for a deleted account would undo the purge.
            report.orphans.push({ userId, facts: facts.length });
            continue;
        }

        const perUser = { userId, written: [], alreadyNoted: [], overLimit: [] };

        for (const [section, text] of Object.entries(factsToNotes(facts, now.getTime()))) {
            // Copied whole even past the cap: what a user told us outranks the
            // limit, and the model's next rewrite of this section has to come in
            // under it regardless. Reported so it is visible.
            if (text.length > NOTE_SECTION_LIMIT) perUser.overLimit.push({ section, length: text.length });

            if (profile.notes?.[section]?.text) {
                perUser.alreadyNoted.push(section);
                continue;
            }
            if (!apply) {
                perUser.written.push(section);
                continue;
            }

            // `: null` matches a missing field as well as a null one, so this
            // only ever fills an empty section — never one written since.
            const result = await db.collection(USERS).updateOne(
                { userId, [`notes.${section}.text`]: null },
                {
                    $set: {
                        [`notes.${section}.text`]: text,
                        [`notes.${section}.previousText`]: null,
                        [`notes.${section}.updatedAt`]: now,
                        updatedAt: now,
                    },
                }
            );
            if (result.modifiedCount) perUser.written.push(section);
            else perUser.alreadyNoted.push(section);
        }

        report.written += perUser.written.length;
        report.users.push(perUser);
        step(
            `user ${userId}: ${facts.length} fact(s) → ` +
            `${perUser.written.length ? perUser.written.join(", ") : "nothing new"}` +
            (perUser.alreadyNoted.length ? `; already noted: ${perUser.alreadyNoted.join(", ")}` : "") +
            (perUser.overLimit.length ? `; over the ${NOTE_SECTION_LIMIT}-char cap: ${perUser.overLimit.map(o => `${o.section}(${o.length})`).join(", ")}` : "")
        );
    }

    if (report.orphans.length) {
        step(`left behind facts for ${report.orphans.length} user(s) with no users row: ${report.orphans.map(o => o.userId).join(", ")}`);
    }

    if (!apply) {
        report.status = "dry-run";
        step(`dry run: would write ${report.written} section(s)`);
        return report;
    }

    report.status = report.written ? "applied" : "nothing-to-do";
    step(report.written
        ? `wrote ${report.written} section(s). userFact and factKey are untouched — they are the backup.`
        : "every section with facts to copy already has notes");
    return report;
}

export default runFactsIntoNotes;
