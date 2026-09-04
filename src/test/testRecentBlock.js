/**
 * Hand-run:  node src/test/testRecentBlock.js
 *
 * Guards the RECENTLY block — the half of the memory the agent reads. No .env,
 * no network, no DB: the render is pure and takes rows as an argument.
 *
 * Pass --show to print a rendered example.
 */
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
