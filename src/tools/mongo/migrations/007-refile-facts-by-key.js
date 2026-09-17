/**
 * Re-file what 005 copied from the fact store, by each fact's KEY.
 *
 * 005 filed a fact by its category when one was set, falling back to the key's
 * namespace — the precedence the old profile renderer used. But the category was
 * a label the model chose, and on prod it was wrong: a housing.parking fact
 * carried category "routine", so a months-long parking hunt became the whole of
 * someone's Routine note, rendered into every prompt. The key's namespace had it
 * right, so this files the same facts again by the key alone.
 *
 * Only sections still EXACTLY as 005 wrote them are touched. A section the model
 * or the person has rewritten since is theirs: a user with any such section among
 * the ones that would change is left alone, and reported.
 *
 * DRY RUN BY DEFAULT. The report carries userIds, section names and counts —
 * never a word of what anyone said.
 */
import { getDB } from "../mongoClient.js";
import { USERS } from "../schema/usersSchema.js";
import { USER_FACT } from "../schema/userFactSchema.js";
import { factsToNotes } from "./005-facts-into-notes.js";

const MIGRATION = "007-refile-facts-by-key";

/** The section a fact belongs in, by its key's namespace — its category is ignored. */
export function sectionForFactKey(fact) {
    const key = String(fact?.key ?? "");
    if (key === "money.goals") return "longTermGoals";

    const namespace = key.split(".")[0];
    if (namespace === "routine") return "routine";
    if (namespace === "style") return "behaviour";
    return "about";
}

/**
 * What to rewrite for one user, or why nothing. Pure.
 *
 * 005 stamped every section it wrote with one moment, and which facts were live
 * depends on it, so that moment is found first — as the updatedAt at which the
 * copy reproduces a section's current text exactly. Filing the same live facts
 * by key is then the target; a fact that has expired since is no reason to
 * rewrite anything.
 *
 *  refile           moves: { section: { from, to } } — `to` null clears it
 *  rewritten-since  a section that would change is no longer 005's text
 *  already-by-key   filing by key gives the same notes
 *  not-from-facts   no section holds anything 005 wrote
 */
export function planRefile(facts, notes) {
    const times = [...new Set(Object.values(notes ?? {})
        .map(n => (n?.updatedAt ? new Date(n.updatedAt).getTime() : null))
        .filter(Number.isFinite))];
    const matches = (copy) => Object.keys(copy).length > 0 &&
        Object.entries(copy).some(([section, text]) => notes?.[section]?.text === text);

    const when = times.find(t => matches(factsToNotes(facts, t)));
    if (when === undefined) {
        const refiled = times.some(t => {
            const byKey = factsToNotes(facts, t, sectionForFactKey);
            return matches(byKey) && Object.entries(byKey).every(([section, text]) => notes?.[section]?.text === text);
        });
        return { status: refiled ? "already-by-key" : "not-from-facts", moves: {} };
    }

    const copied = factsToNotes(facts, when);
    const byKey = factsToNotes(facts, when, sectionForFactKey);
    const sections = [...new Set([...Object.keys(copied), ...Object.keys(byKey)])]
        .filter(section => (copied[section] ?? null) !== (byKey[section] ?? null));
    if (!sections.length) return { status: "already-by-key", moves: {} };

    const rewritten = sections.filter(section => (notes?.[section]?.text ?? null) !== (copied[section] ?? null));
    if (rewritten.length) return { status: "rewritten-since", rewritten, moves: {} };

    return {
        status: "refile",
        moves: Object.fromEntries(sections.map(section => [section, { from: copied[section] ?? null, to: byKey[section] ?? null }])),
    };
}

/**
 * @param {object}  [options]
 * @param {boolean} [options.apply] false (default) reports only; true writes.
 */
export async function runRefileFactsByKey({ apply = false } = {}) {
    const db = await getDB();
    const now = new Date();
    const report = {
        apply,
        database: db.databaseName,
        status: "pending",
        refiled: [],
        skipped: [],
        steps: [],
    };
    const step = (m) => { report.steps.push(m); console.log(`[migration:${MIGRATION}] ${m}`); };

    const owners = await db.collection(USER_FACT).distinct("userId");
    for (const userId of owners) {
        const profile = await db.collection(USERS).findOne({ userId }, { projection: { notes: 1 } });
        if (!profile) continue;

        const facts = await db.collection(USER_FACT).find({ userId }).toArray();
        const plan = planRefile(facts, profile.notes);
        if (plan.status === "rewritten-since") {
            report.skipped.push({ userId, reason: plan.status, sections: plan.rewritten });
            step(`user ${userId}: left alone — rewritten since the copy: ${plan.rewritten.join(", ")}`);
            continue;
        }
        if (plan.status !== "refile") continue;

        const sections = Object.keys(plan.moves);
        if (!apply) {
            report.refiled.push({ userId, sections });
            step(`user ${userId}: would re-file ${sections.join(", ")}`);
            continue;
        }

        // Every section pinned to the text this plan was made from, so a write
        // that lands in between leaves the whole user untouched.
        const filter = { userId };
        const set = { updatedAt: now };
        for (const [section, { from, to }] of Object.entries(plan.moves)) {
            filter[`notes.${section}.text`] = from;
            set[`notes.${section}.text`] = to;
            set[`notes.${section}.previousText`] = from;
            set[`notes.${section}.updatedAt`] = now;
        }
        const result = await db.collection(USERS).updateOne(filter, { $set: set });
        if (result.modifiedCount) {
            report.refiled.push({ userId, sections });
            step(`user ${userId}: re-filed ${sections.join(", ")}`);
        } else {
            report.skipped.push({ userId, reason: "changed-during-run", sections });
            step(`user ${userId}: notes changed while this ran — left alone`);
        }
    }

    if (!apply) {
        report.status = "dry-run";
        step(`dry run: would re-file notes for ${report.refiled.length} user(s)`);
        return report;
    }
    report.status = report.refiled.length ? "applied" : "nothing-to-do";
    step(report.refiled.length
        ? `re-filed notes for ${report.refiled.length} user(s); previousText holds what each section said before`
        : "every copied fact is already where its key puts it");
    return report;
}

export default runRefileFactsByKey;
