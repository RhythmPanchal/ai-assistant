/**
 * Days to summarise, and what a correct summary of each must and must not say.
 *
 * These are the failure modes seen while iterating on the prompt, frozen so a
 * later edit cannot quietly bring one back. Each is a shape of day rather than
 * a topic: a day that changes state, a day that resolves it, a day with nothing
 * in it, a day that is all routine.
 *
 * A scenario with `schedule` and `taskLogs` is also a day to review: the rows
 * the job would read from userSchedule and taskRegister, measured against each
 * other, with the scores the review gives the day.
 */

const prev = (state, openThreads, date = "2026-09-02") => ({
    date: new Date(`${date}T00:00:00+05:30`),
    headline: "Previous day.",
    state,
    openThreads,
});

const slot = (n, startTime, endTime, title, category = "Work") =>
    ({ slotId: `slot_${n}`, startTime, endTime, title, category, status: "Planned", taskRef: null });
const logged = (...performedTasks) => [{ performedTasks }];
const task = (title, minutes, category = "Work") =>
    ({ title, actualDurationMinutes: minutes, status: "Completed", taskId: null, category });

const score = (r, key) => (key === "productivity" ? r.productivity : r.ratings?.[key])?.score ?? null;
const outcomeOf = (r, pattern) => r.productivity?.blocks.find(b => pattern.test(b.title))?.outcome;
const reviewed = (r) => JSON.stringify({
    verdict: r.productivity?.verdict,
    followedPct: r.productivity?.followedPct,
    blocks: r.productivity?.blocks.map(b => `${b.title} → ${b.outcome}${b.work.length ? ` [${b.work.join(" + ")}]` : ""}`),
    productivity: [r.productivity?.score, r.productivity?.why],
    mood: [r.mood, r.ratings?.mood?.score, r.ratings?.mood?.why],
    health: [r.ratings?.health?.score, r.ratings?.health?.why],
    overall: [r.ratings?.overall?.score, r.ratings?.overall?.why],
});
const summaryFields = (r) =>
    ({ headline: r.headline, state: r.state, openThreads: r.openThreads, mentioned: r.mentioned, followThrough: r.followThrough, mood: r.mood });

export const SCENARIOS = [
    {
        name: "state-change",
        why: "a health state appears mid-day and must reach tomorrow's planner",
        logDate: "2026-09-03",
        previous: prev(
            ["Q3 deck review with Ankit due Fri 4th"],
            ["Waiting on Ankit's comments on the Q3 deck"]
        ),
        transcript: `
[08:30] user: not feeling great, slight fever since morning
[09:00] rasmalai (morning routine): Light day then:
  09:30-11:00  Q3 deck - review Ankit's comments
  11:30-13:00  Standup + inbox
  Skipping the gym block.
[09:05] user: ok fine
[14:20] user: fever went up, going to the hospital now
[19:40] user: they admitted me, overnight for observation. blood tests done, reports tomorrow
[19:42] user: told ankit the deck review has to move to monday
[21:15] user: watching loki in the hospital bed lol, actually pretty good
[23:14] user: barely ate, just hospital khichdi. spent 800 on the cab and admission. didn't touch the deck
[23:15] rasmalai (night routine): Logged: 1 meal (Dinner), Rs 800 on Health. Nothing on tasks.
`.trim(),
        checks: [
            { field: "state", must: /hospital|admitted/i, why: "tomorrow's schedule depends on knowing this" },
            { field: "openThreads", must: /blood test|report/i, why: "the thing to ask about tomorrow" },
            { field: "mentioned", must: /loki/i, why: "the passing detail with no other home" },
            { field: "mentioned", mustNot: /khichdi|\b800\b|spent|ate\b/i, why: "already in dietRegister and expenseRegister" },
            { field: "followThrough", must: /\w/, why: "a plan existed and was not followed" },
            { fn: (r) => score(r, "health") !== null && score(r, "health") <= 2, why: "a day that ends admitted to hospital is a bad health day", detail: reviewed },
        ],
    },

    {
        name: "state-resolves",
        why: "yesterday's state must be DROPPED once it stops being true, not carried forever",
        logDate: "2026-09-04",
        previous: prev(
            [
                "Admitted to hospital as of Thu evening, under observation",
                "Blood test results pending",
                "Q3 deck review with Ankit moved to Mon 7th",
            ],
            ["Waiting on blood test results"],
            "2026-09-03"
        ),
        transcript: `
[10:15] user: reports came back clean, just a viral thing. discharged an hour ago
[10:16] rasmalai: Good. Anything you're told to avoid?
[10:20] user: doctor said rest till sunday, no gym no running
[16:00] user: worked a couple of hours from home, cleared the inbox
`.trim(),
        checks: [
            { field: "state", must: /rest|no gym|no running|exertion/i, why: "the new constraint" },
            { field: "state", mustNot: /admitted|under observation/i, why: "they were discharged — stale state is worse than none" },
            { field: "openThreads", mustNot: /waiting on blood|results pending/i, why: "the results arrived; asking again is the failure" },
            { field: "state", must: /deck|Mon 7th|Ankit/i, why: "unresolved items still carry forward" },
        ],
    },

    {
        name: "quiet-day",
        why: "a thin day must not be padded with invented state",
        logDate: "2026-09-05",
        previous: null,
        transcript: `
[13:40] user: lunch was 220, thali place near office
[13:40] rasmalai: Logged Rs 220, Food.
`.trim(),
        checks: [
            { fn: (r) => r.state.length <= 1, why: "nothing here establishes ongoing state" },
            { field: "mentioned", mustNot: /220|thali|lunch/i, why: "already an expense row" },
        ],
    },

    {
        name: "empty-day",
        why: "silence must carry state forward, not blank it",
        logDate: "2026-09-06",
        previous: prev(
            ["Advised rest, no exertion until Sun 7th", "Q3 deck review with Ankit on Mon 8th"],
            ["Whether to push the Mon review again"],
            "2026-09-05"
        ),
        transcript: "(no conversation was recorded on this day)",
        checks: [
            { field: "state", must: /rest|exertion|deck|Ankit/i, why: "a silent day does not end a constraint" },
            { fn: (r) => r.mentioned.length === 0, why: "nothing was said, so nothing came up" },
            { fn: (r) => ["productivity", "mood", "health", "overall"].every(k => score(r, k) === null), why: "a day with nothing said has nothing to score", detail: reviewed },
        ],
    },

    {
        name: "routine-only",
        why: "the schedule draft is already in userSchedule and must not be retold",
        logDate: "2026-09-07",
        previous: null,
        transcript: `
[09:00] rasmalai (morning routine): Here's today:
  09:30-10:30  Standup and inbox
  10:30-12:30  Compaction changes for lowes prod
  12:30-13:30  Lunch
  14:00-16:00  Q3 deck rework
  16:00-17:00  Review PRs
  19:00-20:00  Gym - legs
[09:41] user: ok
[23:00] rasmalai (night routine): How was the day - what did you finish, eat, spend?
[23:52] user: honestly did nothing from the plan, got pulled into a prod issue all day. no gym. ordered food, 460
`.trim(),
        checks: [
            { field: "headline", mustNot: /09:30|10:30|12:30|14:00|16:00/, why: "slot times are stored in userSchedule" },
            { field: "followThrough", must: /nothing|none|did not|didn'?t|prod/i, why: "planned vs actual is the whole point of the field" },
            { field: "mentioned", mustNot: /460|ordered food/i, why: "already an expense row" },
        ],
    },

    {
        name: "overload",
        why: "a dump of everything must come back bounded, not as a transcript",
        logDate: "2026-09-08",
        previous: null,
        transcript: `
[22:10] user: ok so today was a lot. shipped the compaction fix, had 3 meetings, one with the lowes team about the migration which is now moved to next quarter. mom called about the wedding in november, need to book tickets. rent is due friday. my laptop battery is dying, need to get it looked at. also i think i'm getting sick again, throat hurts. skipped gym obviously. spent 340 on lunch and 1200 on a cab to the airport for the client thing. oh and i still haven't replied to the recruiter from monday
[22:11] rasmalai: Logged: Rs 340 Food, Rs 1200 Travel. Shipped compaction fix logged.
[22:14] user: ya that's everything, exhausted
`.trim(),
        checks: [
            { fn: (r) => r.state.length <= 6 && r.openThreads.length <= 6 && r.mentioned.length <= 5, why: "the caps are the prompt's job before they are the code's" },
            { field: "mentioned", mustNot: /\b340\b|\b1200\b/, why: "already expense rows" },
            { fn: (r) => JSON.stringify(summaryFields(r)).length < 2200, why: "a dump must be compressed, not transcribed" },
            { fn: (r) => score(r, "health") !== null && score(r, "health") <= 3, why: "a sore throat, a skipped gym and 'exhausted' is not a good health day", detail: reviewed },
        ],
    },

    {
        name: "recall-only",
        why: "the Loki case — a day of pure passing detail still has to be worth storing",
        logDate: "2026-09-09",
        previous: null,
        transcript: `
[21:02] user: finished loki s2 finally. the ending was better than i expected
[21:03] rasmalai: Noted.
[21:30] user: rohan's moving to bangalore next month btw, we were talking about maybe doing a trip before he goes
[21:45] user: also been thinking i should pick up swimming instead of the gym, my knee keeps acting up
`.trim(),
        checks: [
            { field: "mentioned", must: /loki/i, why: "this is the query the feature exists to answer" },
            { field: "mentioned", must: /rohan|bangalore/i, why: "a person and a plan, both worth recalling" },
            { fn: (r) => r.mentioned.length >= 2, why: "three distinct things came up" },
        ],
    },

    // ------------------------------------------------------------ reviews --
    // The schedule and the task log as the job reads them. The plan's titles
    // are the assistant's and the log's are the person's, so every match here
    // has to be made on meaning.

    {
        name: "followed-the-plan",
        why: "everything planned was done, logged in different words — matched, followed, and scored as a good day",
        logDate: "2026-09-10",
        previous: null,
        schedule: {
            slots: [
                slot(1, "09:30", "10:00", "Standup"),
                slot(2, "10:00", "12:00", "Q3 deck - address Ankit's comments"),
                slot(3, "12:30", "13:30", "Lunch", "Routine"),
                slot(4, "14:00", "15:30", "Fix login rate-limit bug"),
                slot(5, "18:30", "19:30", "Gym - legs", "Health"),
            ],
        },
        taskLogs: logged(
            task("daily standup", 30),
            task("went through ankit's deck comments, sent v2", 120),
            task("rate limiter bug fixed and PR raised", 90),
            task("leg day", 60, "Health"),
        ),
        transcript: `
[09:00] rasmalai (morning routine): Here's today: standup 09:30, Ankit's deck comments 10:00-12:00, the login rate-limit bug 14:00-15:30, legs at the gym 18:30.
[09:04] user: looks good, locking it in
[13:10] user: deck v2 sent to ankit, feels good to have it off my plate
[23:05] rasmalai (night routine): How did today go?
[23:08] user: honestly a solid day. did everything on the plan - standup, deck comments, the rate limit bug, and legs at the gym. feeling sharp
[23:09] rasmalai (night routine): Got all four. Anything to eat or spend?
[23:10] user: nothing to log there, gn
`.trim(),
        checks: [
            { fn: (r) => r.productivity?.verdict === "followed the plan", why: "every block was matched to its work despite the different wording", detail: reviewed },
            { fn: (r) => r.productivity?.blocks.every(b => b.outcome === "done"), why: "all four blocks happened", detail: reviewed },
            { fn: (r) => score(r, "productivity") >= 4, why: "a full plan, done", detail: reviewed },
            { fn: (r) => score(r, "mood") >= 4, why: "'a solid day… feeling sharp'", detail: reviewed },
            { field: "followThrough", must: /\ball\b|everything|every|as planned|followed|full plan|completed/i, why: "nothing slipped" },
        ],
    },

    {
        name: "did-different-work",
        why: "an outage replaced the plan — different work, still productive, and a mood that changed through the day",
        logDate: "2026-09-11",
        previous: null,
        schedule: {
            slots: [
                slot(1, "10:00", "13:00", "Q3 deck review"),
                slot(2, "13:00", "14:00", "Lunch", "Routine"),
                slot(3, "14:00", "16:00", "Write API docs for v2"),
                slot(4, "18:00", "19:00", "Gym", "Health"),
            ],
        },
        taskLogs: logged(
            task("payments outage - found and fixed the webhook retry storm", 330),
            task("gym", 60, "Health"),
        ),
        transcript: `
[09:00] rasmalai (morning routine): Here's today: Q3 deck review 10:00-13:00, API docs for v2 14:00-16:00, gym 18:00.
[09:02] user: ok
[10:20] user: payments are down, everyone's on it. super tense, this is bad
[13:45] user: still down. haven't eaten
[16:40] user: FIXED. retry storm from the webhook worker. that was brutal
[23:02] rasmalai (night routine): How did today go?
[23:06] user: whole day went into the outage, no deck review no docs. but made it to the gym after. feeling really good now that it's fixed
[23:07] rasmalai (night routine): Got the outage work and the gym. Anything to eat or spend?
[23:08] user: skipped lunch, dinner was a burger. no spends. gn
`.trim(),
        checks: [
            { fn: (r) => r.productivity?.verdict === "did different work", why: "the outage took the planned hours", detail: reviewed },
            { fn: (r) => outcomeOf(r, /deck/i) !== "done" && outcomeOf(r, /docs/i) !== "done", why: "the deck review and the docs did not happen", detail: reviewed },
            { fn: (r) => outcomeOf(r, /gym/i) === "done", why: "the gym did", detail: reviewed },
            { fn: (r) => score(r, "productivity") >= 3, why: "five hours fixing an outage is real work, off-plan or not", detail: reviewed },
            { field: "mood", must: /tense|stress|anxious|worr|pressure/i, why: "the morning was tense" },
            { field: "mood", must: /good|great|reliev|happy|better/i, why: "and the evening was good — both halves belong in it" },
            { fn: (r) => score(r, "mood") !== null, why: "they said how they felt", detail: reviewed },
        ],
    },

    {
        name: "cheerful-but-idle",
        why: "a happy day with almost no work — a high mood must not lift productivity",
        logDate: "2026-09-12",
        previous: null,
        schedule: {
            slots: [
                slot(1, "10:00", "13:00", "Q3 deck review"),
                slot(2, "14:00", "17:00", "Write API docs for v2"),
            ],
        },
        taskLogs: logged(task("replied to emails", 30)),
        transcript: `
[09:00] rasmalai (morning routine): Here's today: Q3 deck review 10:00-13:00, API docs for v2 14:00-17:00.
[09:10] user: sure
[16:30] user: lol not feeling work today. watched two movies, such a chill day, loved it
[23:04] rasmalai (night routine): How did today go?
[23:06] user: best lazy day in ages. only replied to a few emails, maybe half an hour. gn
`.trim(),
        checks: [
            { fn: (r) => r.productivity?.verdict === "fell short of the plan", why: "half an hour of email is not a day of different work", detail: reviewed },
            { fn: (r) => score(r, "productivity") !== null && score(r, "productivity") <= 2, why: "cheerful is not productive", detail: reviewed },
            { fn: (r) => score(r, "mood") >= 4, why: "'best lazy day in ages'", detail: reviewed },
        ],
    },

    {
        name: "boring-day",
        why: "boredom is a mood, and a day of meetings with nothing done is not a productive one",
        logDate: "2026-09-13",
        previous: null,
        schedule: null,
        taskLogs: logged(task("status meetings", 180)),
        transcript: `
[18:10] user: so boring today. back to back status meetings, nothing real got done
[23:01] rasmalai (night routine): How did today go?
[23:03] user: meh. same as i said, just meetings. dal rice for dinner, no spends. gn
`.trim(),
        checks: [
            { field: "mood", must: /bor|dull|meh|flat|uneventful|monoton|tedious/i, why: "they said it was boring" },
            { fn: (r) => r.productivity?.verdict === "no plan", why: "no schedule was locked in", detail: reviewed },
            { fn: (r) => score(r, "productivity") !== null && score(r, "productivity") <= 3, why: "'nothing real got done'", detail: reviewed },
            { fn: (r) => score(r, "mood") !== null && score(r, "mood") <= 3, why: "bored is not a good mood", detail: reviewed },
        ],
    },

    {
        name: "no-feelings",
        why: "a purely logistical wrap-up gives no mood or health to score — null, never a filler 3",
        logDate: "2026-09-14",
        previous: null,
        schedule: { slots: [slot(1, "11:00", "13:00", "Write API docs for v2")] },
        taskLogs: logged(task("api docs v2", 120)),
        transcript: `
[23:02] rasmalai (night routine): How did today go?
[23:04] user: api docs, 2 hours. lunch dal rice, dinner roti sabzi. spent 200 on groceries
[23:05] rasmalai (night routine): Got the docs, both meals and the groceries. Anything else?
[23:05] user: no
`.trim(),
        checks: [
            { fn: (r) => r.productivity?.verdict === "followed the plan", why: "the one block was done", detail: reviewed },
            { fn: (r) => score(r, "mood") === null, why: "they never said how they felt", detail: reviewed },
            { fn: (r) => score(r, "health") === null, why: "nothing about their body was said", detail: reviewed },
            { fn: (r) => r.mood === null, why: "no signal, no mood", detail: reviewed },
        ],
    },

    {
        name: "said-but-not-logged",
        why: "no wrap-up that night — nothing was logged, but the chat says the work happened",
        logDate: "2026-09-15",
        previous: null,
        schedule: {
            slots: [
                slot(1, "10:00", "12:00", "Q3 deck review"),
                slot(2, "18:00", "19:00", "Gym", "Health"),
            ],
        },
        taskLogs: [],
        transcript: `
[09:00] rasmalai (morning routine): Here's today: Q3 deck review 10:00-12:00, gym 18:00.
[09:01] user: ok
[12:15] user: deck review done, ankit liked it
[19:20] user: gym done, chest day
`.trim(),
        checks: [
            { fn: (r) => r.productivity?.verdict === "nothing logged", why: "the task log is empty", detail: reviewed },
            { fn: (r) => outcomeOf(r, /deck/i) === "done" && outcomeOf(r, /gym/i) === "done", why: "both were said to be done", detail: reviewed },
            { field: "followThrough", mustNot: /did nothing|nothing (from|on|of) the plan|didn'?t do|none of|not done|skipped/i, why: "nothing logged is not nothing done" },
        ],
    },
];

export default SCENARIOS;
