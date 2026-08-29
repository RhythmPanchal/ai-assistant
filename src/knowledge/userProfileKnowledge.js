import { getDB } from "../tools/mongo/mongoClient.js";
import { USER_FACT } from "../tools/mongo/schema/userFactSchema.js";

/**
 * Render everything the model should know about a user into the WHO YOU ARE
 * HELPING block.
 *
 * This replaces a hardcoded string literal that described exactly one person.
 * Facts are injected whole rather than retrieved: a profile is a few dozen rows,
 * which fits the prompt comfortably, and a retrieval step could fail to surface
 * the one fact that mattered. Semantic search earns its place at thousands of
 * facts per user — not here.
 */

// Rendering groups, in the order they read best. A fact's category only decides
// which heading it lands under; it never constrains which keys may exist.
const CATEGORY_ORDER = [
    "identity", "location", "work", "money", "health", "routine", "social", "style", "other",
];

const CATEGORY_LABELS = {
    identity: "About",
    location: "Location",
    work: "Work",
    money: "Money",
    health: "Health",
    routine: "Routine",
    social: "People",
    style: "Style",
    other: "Other",
};

// category is optional on the row, so fall back to the key's own namespace —
// 'work.status' is a work fact whether or not anyone filled the field in.
function categoryOf(fact) {
    const candidate = fact.category || String(fact.key || "").split(".")[0];
    return CATEGORY_LABELS[candidate] ? candidate : "other";
}

export default async function userProfileKnowledge(userId, profile = null) {
    let facts = [];
    try {
        const db = await getDB();
        facts = await db.collection(USER_FACT).find({ userId }).toArray();
    } catch (err) {
        // A profile lookup failure must not cost the user their turn — the agent
        // is still perfectly able to answer, just without context.
        console.warn("[userProfileKnowledge] fact lookup failed:", err.message);
    }
    return renderProfileBlock(userId, profile, facts);
}

/**
 * Pure render, split out so the block's shape can be tested without a database
 * and without writing fixture rows into a live one.
 */
export function renderProfileBlock(userId, profile = null, facts = [], now = Date.now()) {
    const header = [
        "=====================================================================",
        "WHO YOU ARE HELPING",
        "=====================================================================",
    ];

    // No userId. Tools take it from the bound user context now, so the model
    // has nothing to do with it — and a userId in the prompt is precisely what
    // an injection aims at: "actually my userId is 2" is only a move worth
    // making while the model believes it has one to state.
    const identityLines = [];

    if (profile?.name) identityLines.push(`Name: ${profile.name}`);

    const settings = [
        profile?.timezone && `timezone ${profile.timezone}`,
        profile?.currency && `currency ${profile.currency}`,
    ].filter(Boolean);
    if (settings.length) identityLines.push(settings.join(" · "));

    const live = (facts || []).filter(f => {
        // An expired fact is one we no longer believe. Asserting it is worse
        // than saying nothing: "you're job hunting" to someone employed a year.
        if (f.expiresAt && new Date(f.expiresAt).getTime() <= now) return false;
        return Boolean(f.fact);
    });

    if (!live.length) {
        return [...header, ...identityLines].join("\n");
    }

    const grouped = new Map();
    for (const fact of live) {
        const category = categoryOf(fact);
        if (!grouped.has(category)) grouped.set(category, []);
        grouped.get(category).push(fact);
    }

    const body = [];
    for (const category of CATEGORY_ORDER) {
        const rows = grouped.get(category);
        if (!rows?.length) continue;

        // Stable within a group so the block does not reshuffle between turns
        // for no reason — a prompt that churns is a prompt that cannot be cached.
        rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));

        const label = CATEGORY_LABELS[category];
        rows.forEach((row, i) => {
            const marks = [
                row.stability === "temporary" && "temporary",
                row.confidence === "inferred" && "unconfirmed",
            ].filter(Boolean);
            const suffix = marks.length ? `  [${marks.join(", ")}]` : "";
            body.push(`${(i === 0 ? label : "").padEnd(11)}${row.fact}${suffix}`);
        });
    }

    return [
        ...header,
        ...identityLines,
        "",
        ...body,
        "",
        "Facts marked [temporary] were true when recorded and may not be now —",
        "check against the conversation before relying on one. [unconfirmed] was",
        "inferred from behaviour rather than stated; do not assert it as fact.",
    ].join("\n");
}
