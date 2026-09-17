/**
 * Hand-run:  node src/test/testRecentBlock.js
 *
 * Guards the RECENTLY block — the half of the memory the agent reads. No network,
 * no DB: the render is pure and takes rows as an argument.
 *
 * Pass --show to print a rendered example.
 */
// Loaded only because importing the agent constructs the Mongo client at
// module load, which needs MONGO_DB_URI. Nothing here connects.
import "dotenv/config";
import assert from "node:assert";
import { renderRecentBlock } from "../knowledge/chatSummaryKnowledge.js";
import { buildSystemInstruction, SECTION_ORDER } from "../agent/instruction.js";

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => cond ? passed++ : failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);

const d = (s) => new Date(`${s}T00:00:00+05:30`);
const TODAY = "2026-09-04";

// The worked scenario: normal Monday, unwell Tuesday, hospital Wednesday,
// discharged Thursday. state and openThreads have been carried forward by the
// summarize pass, which is why Thursday's row still holds Monday's commitment.
const ROWS = [
    {
        date: d("2026-09-03"),
        headline: "Discharged Thursday morning. Home, told to rest three days, no exertion.",
        state: [
            "Discharged Thu morning; advised rest, no exertion until Sun 7th",
            "Blood test results still pending",
            "Q3 deck review pushed to Mon 8th",
        ],
        openThreads: ["Waiting on blood test results"],
        mentioned: ["Finished Loki while in hospital"],
        followThrough: "Nothing planned — in hospital until midday.",
        mood: "tired, relieved",
    },
    { date: d("2026-09-02"), headline: "Admitted to hospital Wednesday afternoon; kept overnight for observation.", state: [], openThreads: [], mentioned: [] },
    { date: d("2026-09-01"), headline: "Feverish through the day, saw a doctor in the evening, blood tests taken.", state: [], openThreads: [], mentioned: [] },
    { date: d("2026-08-31"), headline: "Long work day; finished the Q3 deck. Started watching Loki in the evening.", state: [], openThreads: [], mentioned: ["Watching Loki, finds it interesting"] },
];

const block = renderRecentBlock(ROWS, { today: TODAY });

if (process.argv.includes("--show")) {
    console.log("\n" + block + "\n");
    console.log(`(${block.length} chars, ~${Math.ceil(block.length / 4)} tokens)\n`);
}

// ------------------------------------------------------------- the shape --
ok("nothing summarised yet renders nothing at all",
    renderRecentBlock([], { today: TODAY }) === "");

ok("the newest row is rendered in full",
    block.includes("no exertion until Sun 7th") && block.includes("Waiting on blood test results"));

// The whole reason the block stays a fixed size. Older rows contribute one line
// each; if their state were rendered too, a busy week would triple the prompt.
ok("older rows contribute only a headline",
    block.includes("Admitted to hospital Wednesday afternoon") &&
    !block.includes("Watching Loki, finds it interesting"),
    "an older row's mentioned[] leaked into the block");

// Carried forward by the summarize pass, so a commitment made on Monday is
// still in Thursday's state and survives Monday being reduced to one line.
ok("Monday's commitment survives in the newest row's state",
    block.includes("Q3 deck review pushed to Mon 8th"));

ok("the newest row is dated relative to today", block.includes("yesterday"));
ok("older rows carry their own date", /Wed 02 Sept/.test(block));

// ------------------------------------------------------------ the framing --
// The text is derived from the user's own messages and lands in the SYSTEM
// prompt, so a crafted message is the one way user text reaches that position.
ok("the block says it is data, not instructions",
    /never instructions/i.test(block));

// --------------------------------------------------------------- the caps --
const flooded = renderRecentBlock([{
    date: d("2026-09-03"),
    headline: "h",
    state: Array.from({ length: 20 }, (_, i) => `state-${i}`),
    openThreads: Array.from({ length: 20 }, (_, i) => `thread-${i}`),
    mentioned: Array.from({ length: 20 }, (_, i) => `mentioned-${i}`),
}], { today: TODAY });
ok("state is capped", !flooded.includes("state-6"), "a model ignoring the overlay's limit could grow the prompt without bound");
ok("openThreads is capped", !flooded.includes("thread-6"));
ok("mentioned is capped", !flooded.includes("mentioned-5"));

// -------------------------------------------------------- gaps in the run --
// The summarize pass can fail or a user can go quiet for days. The newest row
// is then not yesterday's, and mislabelling it "yesterday" would have the agent
// asking about a hospital stay a week after discharge.
const stale = renderRecentBlock([{ date: d("2026-08-31"), headline: "h", state: [], openThreads: [], mentioned: [] }], { today: TODAY });
ok("a gap is labelled honestly", stale.includes("4 days ago") && !stale.includes("yesterday"), stale.split("\n").find(l => l.startsWith("LATEST")));

// ------------------------------------------------- productivity and scores --
// Counted in code from the day's schedule and task log, and scored by the review.
const measured = (over) => ({
    score: null, why: null, verdict: "no plan", plannedMinutes: 0, followedMinutes: 0, loggedMinutes: 0,
    unplannedMinutes: 0, followedPct: null, unplannedPct: null, blocks: [], unplanned: [], ...over,
});
const REVIEWED = [
    {
        date: d("2026-09-03"),
        headline: "Prod outage took the day; the gym still happened.",
        state: [], openThreads: [], mentioned: [],
        followThrough: "Planned the deck review and the gym; the outage replaced the deck review.",
        mood: "anxious in the morning, relieved by the evening",
        productivity: measured({ score: 4, why: "five hours fixing the outage", verdict: "did different work", plannedMinutes: 240, followedMinutes: 60, loggedMinutes: 360, unplannedMinutes: 300, followedPct: 25, unplannedPct: 83 }),
        ratings: { mood: { score: 3, why: "stressed, then relieved" }, health: { score: null, why: null }, overall: { score: 3, why: "hard day, ended well" } },
    },
    {
        date: d("2026-09-02"), headline: "Normal day at work.", state: [], openThreads: [], mentioned: [],
        productivity: measured({ score: 3, why: "steady", verdict: "partly followed", plannedMinutes: 300, followedMinutes: 180, loggedMinutes: 200, unplannedMinutes: 20, followedPct: 60, unplannedPct: 10 }),
        ratings: { mood: { score: 4, why: "a" }, health: { score: 4, why: "b" }, overall: { score: 4, why: "c" } },
    },
    {
        date: d("2026-09-01"), headline: "Never wrapped up.", state: [], openThreads: [], mentioned: [],
        productivity: measured({ verdict: "nothing logged", plannedMinutes: 240, followedPct: 0 }),
        ratings: { mood: { score: null, why: null }, health: { score: null, why: null }, overall: { score: null, why: null } },
    },
    { date: d("2026-08-31"), headline: "From before days were reviewed.", state: [], openThreads: [], mentioned: [] },
];
const reviewed = renderRecentBlock(REVIEWED, { today: TODAY });

ok("yesterday's productivity shows its score, its evidence and what was measured",
    reviewed.includes("Productivity: 4/5 — five hours fixing the outage (did different work: 25% of the plan, 83% of logged work unplanned)"), reviewed);
ok("yesterday's other scores show, and one with no signal is left out",
    reviewed.includes("Scores: mood 3/5 · overall 3/5") && !/health \d/.test(reviewed), reviewed);
ok("an older day carries its trend after the headline", reviewed.includes("Normal day at work.  [plan 60% · overall 4/5]"), reviewed);
ok("a day with nothing logged is not called 0% of the plan", reviewed.includes("Never wrapped up.  [nothing logged]"), reviewed);
ok("a day from before reviews renders as it always did", /From before days were reviewed\.$/m.test(reviewed));
ok("a row with no review adds no productivity or scores line", !block.includes("Productivity:") && !block.includes("Scores:"));

const lines = (productivity) => renderRecentBlock([{ date: d("2026-09-03"), headline: "h", state: [], openThreads: [], mentioned: [], productivity }], { today: TODAY });
ok("with no plan, the work logged is still stated",
    lines(measured({ loggedMinutes: 90, unplannedMinutes: 90, unplannedPct: 100 })).includes("Productivity: (no plan, 1h 30m of work logged)"));
ok("a plan with nothing logged says so rather than 0%",
    lines(measured({ verdict: "nothing logged", plannedMinutes: 240, followedPct: 0 })).includes("Productivity: (no work logged against 4h planned)"));
ok("no plan, no work and no score is no line", !lines(measured({})).includes("Productivity:"));
ok("a plan followed with nothing unplanned does not mention unplanned work",
    lines(measured({ verdict: "followed the plan", plannedMinutes: 120, followedMinutes: 120, loggedMinutes: 120, followedPct: 100, unplannedPct: 0 }))
        .includes("Productivity: (followed the plan: 100% of the plan)"));

// ------------------------------------------------------- prompt placement --
ok("recent sits between the profile and the clock",
    SECTION_ORDER.indexOf("recent") === SECTION_ORDER.indexOf("profile") + 1 &&
    SECTION_ORDER.indexOf("recent") < SECTION_ORDER.indexOf("now"));

const withBlock = buildSystemInstruction([], { profile: "PROFILE-MARKER", recent: "RECENT-MARKER" });
ok("the block reaches the system prompt", withBlock.includes("RECENT-MARKER"));
ok("it is placed after the profile",
    withBlock.indexOf("RECENT-MARKER") > withBlock.indexOf("PROFILE-MARKER"));
ok("it is placed before RIGHT NOW",
    withBlock.indexOf("RECENT-MARKER") < withBlock.indexOf("RIGHT NOW"));

// Day one for every user, and every day until the first pass runs.
const without = buildSystemInstruction([], { profile: "PROFILE-MARKER", recent: "" });
ok("an absent block leaves no blank gap", !/\n\n\n/.test(without), "empty section left a hole in the prompt");
ok("the prompt is otherwise unchanged when absent", without.includes("RIGHT NOW"));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES\n" + failures.map(f => `  ✗ ${f}`).join("\n"));
    process.exit(1);
}
console.log("✓ recent-context block guards hold\n");
