/**
 * Hand-run:
 *   node src/test/testCritiqueLive.js --dry                  fixture day, prints both messages, no key needed
 *   node src/test/testCritiqueLive.js                        fixture day -> a real model call, writes no file
 *   node src/test/testCritiqueLive.js --from-db 1 2026-11-09  a real day from the database
 *   node src/test/testCritiqueLive.js --from-db 1 2026-11-09 --write   also writes the report file
 *
 * What the critic actually does with a day, as opposed to what the coercer
 * permits. testCritique.js is the guard; this is for reading the output.
 */
import "dotenv/config";
import { renderTurns } from "../knowledge/turnReviewKnowledge.js";
import turnReviewKnowledge from "../knowledge/turnReviewKnowledge.js";
import { critiqueDay, buildCritiqueMessages } from "../agent/critique/critiqueDay.js";
import { renderCritiqueReport } from "../agent/critique/critiqueReport.js";
import { critiqueDayJob } from "../scheduler/jobs/critiqueDayJob.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const IST = "Asia/Kolkata";

// A day built to contain exactly one of each thing the critic must catch and
// one it must leave alone — so a reply that flags three findings is right and a
// reply that flags five is padding.
const FIXTURE = [
    {
        conversationId: "f1",
        source: "goodMorningJob",
        createdAt: new Date("2026-11-09T03:30:00.000Z"), // 09:00 IST
        messages: [
            { role: "user", content: "It is time for the morning planning routine" },
            { role: "assistant", functionCalls: [{ name: "fetchRecord", args: { collection: "taskCalendar", filters: { status: "Pending" } } }] },
            { role: "tool", toolName: "fetchRecord", result: [{ title: "Q3 deck review", requiredMinutes: 90 }] },
            { role: "assistant", content: "Morning. One thing pending: the Q3 deck review, 90 minutes. Shall I block 10:00-11:30?" },
        ],
    },
    {
        // Clean turn. Nothing to find here.
        conversationId: "f2",
        createdAt: new Date("2026-11-09T06:00:00.000Z"), // 11:30 IST
        messages: [
            { role: "user", content: "yes do that" },
            { role: "assistant", functionCalls: [{ name: "insertSchedule", args: { date: "2026-11-09", slots: [{ startTime: "10:00", endTime: "11:30", title: "Q3 deck review" }] } }] },
            { role: "tool", toolName: "insertSchedule", result: { insertedId: "s1" } },
            { role: "assistant", content: "Blocked 10:00-11:30 for the deck review." },
        ],
    },
    {
        // Hallucination test 1: claims a save that no call made.
        conversationId: "f3",
        createdAt: new Date("2026-11-09T14:00:00.000Z"), // 19:30 IST
        messages: [
            { role: "user", content: "spent 240 on lunch today" },
            { role: "assistant", content: "Logged ₹240 for lunch under Food." },
        ],
    },
    {
        // Hallucination test 2: a number present in nothing.
        conversationId: "f4",
        createdAt: new Date("2026-11-09T17:30:00.000Z"), // 23:00 IST
        messages: [
            { role: "user", content: "how much have I spent this month?" },
            { role: "assistant", functionCalls: [{ name: "fetchRecord", args: { collection: "expenseRegister" } }] },
            { role: "tool", toolName: "fetchRecord", result: [{ amount: 240, category: "Food" }, { amount: 50, category: "Travel" }] },
            { role: "assistant", content: "You are at ₹8,420 this month, mostly rent." },
        ],
    },
];

async function main() {
    let userId = 1;
    let logDate = "2026-11-09";
    let transcript;
    let turns;

    const fromDb = argv.indexOf("--from-db");
    if (fromDb !== -1) {
        userId = Number(argv[fromDb + 1]);
        logDate = argv[fromDb + 2];
        if (!Number.isInteger(userId) || !logDate) {
            console.error("usage: --from-db <userId> <YYYY-MM-DD>");
            process.exit(1);
        }
        if (has("--write")) {
            const res = await critiqueDayJob(userId, logDate, IST, true);
            console.log(JSON.stringify(res.critique ?? res, null, 2));
            process.exit(0);
        }
        ({ transcript, turns } = await turnReviewKnowledge(userId, logDate, { timeZone: IST }));
    } else {
        ({ transcript, turns } = renderTurns(FIXTURE, { timeZone: IST }));
    }

    if (has("--dry")) {
        const [system, user] = buildCritiqueMessages({ logDate, transcript, turnCount: turns.length, timeZone: IST });
        console.log("════════ SYSTEM ════════\n");
        console.log(system.content);
        console.log("\n════════ USER ════════\n");
        console.log(user.content);
        console.log(`\n════════ ${system.content.length + user.content.length} chars total ════════`);
        process.exit(0);
    }

    const { critique, provider, model } = await critiqueDay({ userId, logDate, transcript, turns, timeZone: IST });

    console.log(renderCritiqueReport({ userId, logDate, critique, turns, model: `${provider}:${model}`, timeZone: IST }));

    if (fromDb === -1) {
        const kinds = critique.findings.map(f => f.kind);
        console.log("\n──── fixture expectations ────");
        // Two defects planted, in T3 and T4. T4 carries both an invented total
        // and an invented category, which is one wrong reply — folding them
        // into a single finding is correct, splitting them is also defensible.
        console.log(`findings: ${critique.findings.length} (2-3 expected: T3's unsaved claim, T4's invented total and category)`);
        console.log(`turns cited: ${critique.findings.map(f => f.turn).join(", ") || "none"} — T3 and T4 are the planted ones; T2 is clean`);
        console.log(`kinds: ${kinds.join(", ") || "none"}`);
        if (critique.findings.some(f => f.turn === "T2")) console.log("NOTE: T2 is a clean turn — a finding there is the padding reflex.");
    }
    process.exit(0);
}

main().catch(e => {
    console.error(e.message);
    process.exit(1);
});
