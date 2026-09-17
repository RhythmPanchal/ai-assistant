/**
 * Hand-run:  node src/test/testDayReview.js
 *
 * Guards the day review: the plan-vs-logged arithmetic and the parsing of what
 * the review pass returns. No network, no DB — every sum here is done over rows
 * passed in, which is the point of keeping the model out of the maths.
 *
 * For what a real model returns, see eval/evalSummaries.js.
 */
// Loaded only because importing the review pass constructs the Mongo client at
// module load, which needs MONGO_DB_URI. Nothing here connects.
import "dotenv/config";
import { coerceScore, coerceReview, buildReviewMessages } from "../agent/summarize/reviewDay.js";
import { DAY_REVIEW_INSTRUCTION } from "../agent/summarize/reviewPrompt.js";
import {
    workBlocksOf, workItemsOf, exactLinks, comparePlan, verdictFor, formatMinutes,
    describeComparison, VERDICTS, OUTCOMES,
} from "../agent/summarize/planComparison.js";
import ValidateSchema, { normalizeDates } from "../tools/mongo/validateSchema.js";
import chatSummarySchema, { CHAT_SUMMARY } from "../tools/mongo/schema/chatSummarySchema.js";

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => cond ? passed++ : failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const slot = (slotId, startTime, endTime, title, category = "Work", extra = {}) =>
    ({ slotId, startTime, endTime, title, category, status: "Planned", taskRef: null, ...extra });
const done = (title, minutes, extra = {}) => ({ title, actualDurationMinutes: minutes, status: "Completed", taskId: null, ...extra });

const TASK = "66c1a2b3c4d5e6f708192a3b";

// ------------------------------------------------------------------ blocks --
{
    const blocks = workBlocksOf({
        slots: [
            slot("slot_4", "18:00", "19:00", "Gym", "Health"),
            slot("slot_1", "10:00", "13:00", "Q3 deck review"),
            slot("slot_2", "13:00", "14:00", "Lunch", "Routine"),
            slot("slot_3", "14:00", "16:00", "Fix payment webhook bug", "Work", { taskRef: TASK }),
            slot("slot_5", "21:00", "22:00", "Dinner & Unwind", null),
            slot("slot_6", "23:30", "00:30", "Read system design notes", "Learning"),
            slot("slot_7", "16:00", "16:00", "Empty block"),
            slot("slot_8", "9am", "10am", "Bad times"),
        ],
    });

    same("furniture is left out — by category and by title", blocks.map(b => b.title),
        ["Q3 deck review", "Fix payment webhook bug", "Gym", "Read system design notes"]);
    same("ids follow start time, not the order slots were stored in", blocks.map(b => b.id), ["b1", "b2", "b3", "b4"]);
    same("minutes come from the times", blocks.map(b => b.minutes), [180, 120, 60, 60]);
    ok("a block past midnight is an hour, not minus twenty-three", blocks[3].minutes === 60);
    ok("the backlog task on a slot is kept", blocks[1].taskRef === TASK);
    ok("the slot id is kept for the stored row", blocks[0].slotId === "slot_1");
    same("no schedule is no blocks", workBlocksOf(null), []);
}

// -------------------------------------------------------------------- work --
{
    const work = workItemsOf([
        { performedTasks: [done("Prod outage firefight", 300), done("Gym", 60)] },
        { performedTasks: [done("Evening walk", 30, { status: "Skipped" }), done("Fixed webhook", 120, { taskId: TASK })] },
    ]);
    same("every document's entries, in order", work.map(w => w.id), ["w1", "w2", "w3", "w4"]);
    ok("an entry logged as Skipped carries no minutes", work[2].minutes === 0);
    ok("a task id survives", work[3].taskId === TASK);
    same("no log is no work", workItemsOf(null), []);
    ok("a single document is accepted as well as a list",
        workItemsOf({ performedTasks: [done("x", 10)] }).length === 1);
}

// ------------------------------------------------------------------- links --
{
    const blocks = workBlocksOf({ slots: [slot("s1", "10:00", "12:00", "Webhook", "Work", { taskRef: TASK })] });
    const work = workItemsOf({ performedTasks: [done("fixed it", 90, { taskId: TASK }), done("other", 30)] });
    const links = exactLinks(blocks, work);
    ok("work closing the slot's backlog task is linked without a model", links.get("w1") === "b1");
    ok("work with no task id is not linked", !links.has("w2"));
}

// ---------------------------------------------------- the worked example --
// Planned deck review, the webhook fix and the gym. The prod outage ate the
// morning; the webhook fix and the gym still happened.
const DAY = {
    slots: [
        slot("slot_1", "10:00", "13:00", "Q3 deck review"),
        slot("slot_2", "14:00", "16:00", "Fix payment webhook bug", "Work", { taskRef: TASK }),
        slot("slot_3", "18:00", "19:00", "Gym", "Health"),
    ],
};
const LOG = { performedTasks: [done("Prod outage firefight", 300), done("Gym session", 60), done("Fixed webhook retries", 120, { taskId: TASK })] };

{
    const p = comparePlan({
        blocks: workBlocksOf(DAY),
        work: workItemsOf(LOG),
        matches: [
            { block: "b1", work: [], outcome: "not done" },
            { block: "b2", work: [], outcome: "done" },
            { block: "b3", work: ["w2"], outcome: "done" },
        ],
    });
    ok("planned is every block's minutes", p.plannedMinutes === 360, p.plannedMinutes);
    ok("followed counts the webhook (linked by task) and the gym (matched)", p.followedMinutes === 180, p.followedMinutes);
    ok("logged is all the work", p.loggedMinutes === 480, p.loggedMinutes);
    ok("unplanned is the firefight", p.unplannedMinutes === 300, p.unplannedMinutes);
    ok("followed is 50%", p.followedPct === 50, p.followedPct);
    ok("unplanned is 63% of logged", p.unplannedPct === 63, p.unplannedPct);
    ok("half the plan is partly followed", p.verdict === VERDICTS.PARTLY, p.verdict);
    same("each block says what became of it", p.blocks.map(b => b.outcome), ["not done", "done", "done"]);
    same("each block names the work that filled it", p.blocks.map(b => b.work), [[], ["Fixed webhook retries"], ["Gym session"]]);
    same("unplanned work is listed", p.unplanned, [{ title: "Prod outage firefight", minutes: 300 }]);
    ok("the stored block has no working-out field", !("followedMinutes" in p.blocks[0]));
    ok("the stored block keeps its slot id", p.blocks[1].slotId === "slot_2");
}

// ------------------------------------------------------------ the shapes --
{
    const blocks = workBlocksOf({ slots: DAY.slots.map(s => ({ ...s, taskRef: null })) });

    const different = comparePlan({
        blocks,
        work: workItemsOf({ performedTasks: [done("Prod outage firefight", 300), done("Gym", 60)] }),
        matches: [{ block: "b3", work: ["w2"], outcome: "done" }],
    });
    ok("a day of other work is 'did different work'", different.verdict === VERDICTS.DIFFERENT,
        `${different.verdict} ${different.followedPct}% followed, ${different.unplannedPct}% unplanned`);

    const lost = comparePlan({
        blocks,
        work: workItemsOf({ performedTasks: [done("Gym", 60)] }),
        matches: [{ block: "b3", work: ["w1"], outcome: "done" }],
    });
    ok("a day with little work of any kind 'fell short of the plan'", lost.verdict === VERDICTS.SHORT, lost.verdict);

    const obedient = comparePlan({
        blocks,
        work: workItemsOf({ performedTasks: [done("Deck review", 200), done("Webhook", 120), done("Gym", 60)] }),
        matches: [{ block: "b1", work: ["w1"] }, { block: "b2", work: ["w2"] }, { block: "b3", work: ["w3"] }],
    });
    ok("everything done is 'followed the plan'", obedient.verdict === VERDICTS.FOLLOWED, obedient.verdict);
    ok("running over a block does not push followed past 100%", obedient.followedPct === 100, obedient.followedPct);
    same("an outcome the review left out comes from the rows", obedient.blocks.map(b => b.outcome), ["done", "done", "done"]);

    const noPlan = comparePlan({ blocks: [], work: workItemsOf({ performedTasks: [done("Interviews", 60)] }) });
    ok("no schedule is 'no plan'", noPlan.verdict === VERDICTS.NO_PLAN, noPlan.verdict);
    ok("with no plan there is no followed percentage", noPlan.followedPct === null);
    ok("with no plan all work is unplanned", noPlan.unplannedMinutes === 60);

    const silent = comparePlan({ blocks, work: [], matches: [{ block: "b3", work: [], outcome: "done" }] });
    ok("a plan with no logged work is 'nothing logged'", silent.verdict === VERDICTS.NOTHING_LOGGED, silent.verdict);
    ok("with nothing logged there is no unplanned percentage", silent.unplannedPct === null);
    ok("a block the chat says happened keeps 'done' even when nothing was logged", silent.blocks[2].outcome === "done");
    ok("a block nobody mentioned is unclear", silent.blocks[0].outcome === "unclear");
}

// ------------------------------------------------ what the review can't do --
{
    const blocks = workBlocksOf(DAY);
    const work = workItemsOf(LOG);

    const invented = comparePlan({ blocks, work, matches: [{ block: "b9", work: ["w1"], outcome: "done" }, { block: "b1", work: ["w7"], outcome: "banana" }] });
    ok("a block id that does not exist is ignored — the work it claimed stays unplanned",
        invented.unplanned.some(u => u.title === "Prod outage firefight"), JSON.stringify(invented.unplanned));
    ok("a work id that does not exist is ignored", invented.blocks[0].loggedMinutes === 0);
    ok("an outcome outside the list falls back to the rows", invented.blocks[0].outcome === "unclear");

    const greedy = comparePlan({ blocks, work, matches: [{ block: "b1", work: ["w1"] }, { block: "b3", work: ["w1", "w2"] }] });
    ok("a piece of work fills one block — the first claim stands", greedy.blocks[0].loggedMinutes === 300 && greedy.blocks[2].loggedMinutes === 60,
        JSON.stringify(greedy.blocks.map(b => b.loggedMinutes)));

    const stolen = comparePlan({ blocks, work, matches: [{ block: "b1", work: ["w3"], outcome: "done" }] });
    ok("work linked by its backlog task cannot be claimed by another block", stolen.blocks[1].loggedMinutes === 120 && stolen.blocks[0].loggedMinutes === 0);

    const contradicted = comparePlan({ blocks, work, matches: [{ block: "b2", work: [], outcome: "not done" }] });
    ok("'not done' over work the log links to the block gives way to the rows", contradicted.blocks[1].outcome === "done", contradicted.blocks[1].outcome);

    ok("no matches at all still compares by task id", comparePlan({ blocks, work }).followedMinutes === 120);
}

// ------------------------------------------------------------- thresholds --
ok("75% followed is followed", verdictFor({ plannedMinutes: 100, loggedMinutes: 175, followedPct: 75, unplannedMinutes: 100 }) === VERDICTS.FOLLOWED);
ok("74% is partly", verdictFor({ plannedMinutes: 100, loggedMinutes: 74, followedPct: 74, unplannedMinutes: 0 }) === VERDICTS.PARTLY);
ok("40% is partly", verdictFor({ plannedMinutes: 100, loggedMinutes: 140, followedPct: 40, unplannedMinutes: 100 }) === VERDICTS.PARTLY);
ok("39% with other work worth half the plan is different work", verdictFor({ plannedMinutes: 100, loggedMinutes: 89, followedPct: 39, unplannedMinutes: 50 }) === VERDICTS.DIFFERENT);
ok("39% with less other work than that fell short", verdictFor({ plannedMinutes: 100, loggedMinutes: 88, followedPct: 39, unplannedMinutes: 49 }) === VERDICTS.SHORT);
{
    // Half an hour of email is ALL the logged work — 100% unplanned — and
    // still nowhere near a day spent on something else.
    const idle = comparePlan({
        blocks: workBlocksOf({ slots: [slot("s1", "10:00", "13:00", "Q3 deck review"), slot("s2", "14:00", "17:00", "Write API docs")] }),
        work: workItemsOf({ performedTasks: [done("Replied to emails", 30)] }),
    });
    ok("a little unplanned work on a big plan fell short, not different work", idle.verdict === VERDICTS.SHORT,
        `${idle.verdict}: ${idle.unplannedPct}% of logged work unplanned`);
}

// ---------------------------------------------------------------- render --
same("minutes read as hours", [150, 60, 45, 0].map(formatMinutes), ["2h 30m", "1h", "45m", "0m"]);
{
    const p = comparePlan({
        blocks: workBlocksOf({ slots: [...DAY.slots, slot("slot_9", "20:00", "21:00", "Read notes", "Learning", { status: "Skipped" })] }),
        work: workItemsOf(LOG),
        matches: [{ block: "b3", work: ["w2"], outcome: "done" }],
    });
    const text = describeComparison(p);
    ok("the verdict leads", text.includes(`Verdict: ${p.verdict}`), text);
    ok("each block's outcome is shown", /10:00-13:00\s+Q3 deck review: unclear/.test(text), text);
    ok("the work that filled a block is named", text.includes("logged: Gym session (1h)"), text);
    ok("a block dropped during the day says so", text.includes("[skipped during the day]"), text);
    ok("unplanned work is named", text.includes("Not on the plan: Prod outage firefight (5h)"), text);
    ok("no plan says so", describeComparison(comparePlan({ blocks: [], work: [] })).includes("No schedule was locked in"));
    ok("nothing logged says so", describeComparison(comparePlan({ blocks: workBlocksOf(DAY), work: [] })).includes("No work was logged"));
    ok("no productivity renders nothing", describeComparison(null) === "");
}

// ------------------------------------------------------------ the review --
same("scores in the forms models send", [4, "4", "4/5", " 2 ", 3.5, 1, 5].map(coerceScore), [4, 4, 4, 2, 4, 1, 5]);
same("anything outside 1-5 is refused, not clamped", [0, 6, 8, "8/10", -1].map(coerceScore), [null, null, null, null, null]);
same("anything that is not a score is null", [null, undefined, "high", "", {}, NaN].map(coerceScore), [null, null, null, null, null, null]);

{
    const review = coerceReview({
        matches: [
            { block: " b1 ", work: ["w2", 7, null, " w3 "], outcome: "done" },
            { block: "b2", work: "w1", outcome: "banana" },
            { work: ["w1"], outcome: "done" },
            "b3",
        ],
        productivity: { score: "4", why: "  five hours on the outage  " },
        mood: { score: 3, why: "x".repeat(500) },
        health: { score: null, why: "no information about health" },
        overall: { score: 11, why: "great" },
    });
    same("a match keeps its trimmed ids and only string work ids", review.matches[0], { block: "b1", work: ["w2", "w3"], outcome: "done" });
    ok("an outcome outside the list is dropped", review.matches[1].outcome === null && review.matches[1].work.length === 0);
    ok("a match with no block, or that is not an object, is dropped", review.matches.length === 2);
    same("a score and its why are kept", review.productivity, { score: 4, why: "five hours on the outage" });
    ok("a long why is cut to one line's worth", review.ratings.mood.why.length === 200 && review.ratings.mood.why.endsWith("…"));
    same("a why with no score is dropped", review.ratings.health, { score: null, why: null });
    same("a why under a refused score is dropped with it", review.ratings.overall, { score: null, why: null });

    const empty = coerceReview(null);
    same("an unusable reply is no matches and no scores", empty, {
        matches: [],
        productivity: { score: null, why: null },
        ratings: { mood: { score: null, why: null }, health: { score: null, why: null }, overall: { score: null, why: null } },
    });
}

{
    const blocks = workBlocksOf({
        slots: [
            ...DAY.slots,
            slot("slot_4", "20:00", "21:00", "Read notes", "Learning", { status: "Skipped" }),
            slot("slot_5", "13:00", "14:00", "Lunch", "Routine"),
        ],
    });
    const work = workItemsOf({ performedTasks: [...LOG.performedTasks, done("Walk", 20, { status: "Skipped" }), done("Slides", 40, { status: "Partial" })] });
    const messages = buildReviewMessages({ logDate: "2026-09-17", transcript: "[21:40] user: long day", blocks, work });
    const input = messages[1].content;

    ok("the instruction is the system message", messages[0].role === "system" && messages[0].content === DAY_REVIEW_INSTRUCTION);
    ok("the day and its weekday lead", input.startsWith("THE DAY: 2026-09-17 (Thursday)"), input.split("\n")[0]);
    ok("each block is listed with its id, times and minutes", input.includes("b1  10:00-13:00  Q3 deck review  (3h, Work)"), input);
    ok("furniture is not offered to match", !/Lunch/.test(input));
    ok("a block dropped during the day is marked", input.includes("dropped during the day (Skipped)"));
    ok("a block and a log entry sharing a backlog task say so, both ways",
        input.includes("same backlog task as w3") && input.includes("same backlog task as b2"), input);
    ok("each logged entry is listed with its id and minutes", input.includes("w1  Prod outage firefight  (5h)"), input);
    ok("work logged as skipped says so instead of a duration", input.includes("Walk  (logged as skipped)"));
    ok("partial work says so", input.includes("Slides  (40m, partly done)"));
    ok("the transcript is carried", input.includes("[21:40] user: long day"));
    ok("it asks for the object last", input.trim().endsWith("Return the JSON object for 2026-09-17 now."));

    const bare = buildReviewMessages({ logDate: "2026-09-17", transcript: "", blocks: [], work: [] })[1].content;
    ok("no schedule says so", bare.includes("There was no schedule for this day."));
    ok("no log says so", bare.includes("Nothing was logged."));

    ok("the instruction demands the bare object", /Start your reply with \{ and end\s+it with \}/.test(DAY_REVIEW_INSTRUCTION));
    ok("the instruction forbids a default score", /Never fill in a 3/.test(DAY_REVIEW_INSTRUCTION));
    ok("the instruction keeps mood away from the workload", /never infer mood from the workload/.test(DAY_REVIEW_INSTRUCTION));
    ok("the instruction keeps the maths in code", /do not calculate anything/.test(DAY_REVIEW_INSTRUCTION));
}

// ---------------------------------------------------------------- stored --
{
    const schema = chatSummarySchema.properties;
    same("the schema's verdicts are exactly the ones code can produce",
        [...schema.productivity.properties.verdict.enum].sort(), Object.values(VERDICTS).sort());
    same("the schema's outcomes are exactly the ones code can produce",
        [...schema.productivity.properties.blocks.items.properties.outcome.enum].sort(), [...OUTCOMES].sort());

    const productivity = {
        score: 4,
        why: "5h on the outage, then the webhook fix",
        ...comparePlan({ blocks: workBlocksOf(DAY), work: workItemsOf(LOG), matches: [{ block: "b3", work: ["w2"], outcome: "done" }] }),
    };
    const row = {
        userId: 1, period: "day", date: new Date("2026-09-17T00:00:00+05:30"),
        headline: "Prod outage took the morning; the webhook fix and the gym still happened.",
        state: [], openThreads: [], mentioned: [],
        followThrough: "Half the plan: webhook fix and gym done, deck review not started.",
        mood: "anxious in the morning, relieved by the evening",
        productivity,
        ratings: {
            mood: { score: 3, why: "stressed until the fix went out" },
            health: { score: null, why: null },
            overall: { score: 3, why: "hard day that ended well" },
        },
    };

    let error = null;
    try { await ValidateSchema(CHAT_SUMMARY, row); } catch (e) { error = e.message; }
    ok("a row carrying what comparePlan builds passes the schema", !error, error);

    const noPlanRow = { ...row, productivity: { score: null, why: null, ...comparePlan({ blocks: [], work: [] }) } };
    error = null;
    try { await ValidateSchema(CHAT_SUMMARY, noPlanRow); } catch (e) { error = e.message; }
    ok("a day with no plan and nothing logged passes too", !error, error);

    error = null;
    try { await ValidateSchema(CHAT_SUMMARY, { ...row, productivity: { ...productivity, verdict: "great day" } }); } catch (e) { error = e.message; }
    // The validator reports a bad value inside a nullable object as a type
    // error on the object itself, so only the refusal is checked.
    ok("a verdict code does not produce is refused", error !== null, "accepted");

    const before = JSON.stringify(row.productivity) + JSON.stringify(row.ratings);
    normalizeDates(row);
    ok("normalizeDates leaves the new objects alone", JSON.stringify(row.productivity) + JSON.stringify(row.ratings) === before);
}

if (failures.length) {
    console.log(`✗ ${failures.length} failed, ${passed} passed\n`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
}
console.log(`✓ testDayReview: ${passed} passed`);
