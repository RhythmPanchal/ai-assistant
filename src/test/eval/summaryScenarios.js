/**
 * Days to summarise, and what a correct summary of each must and must not say.
 *
 * These are the failure modes seen while iterating on the prompt, frozen so a
 * later edit cannot quietly bring one back. Each is a shape of day rather than
 * a topic: a day that changes state, a day that resolves it, a day with nothing
 * in it, a day that is all routine.
 */

const prev = (state, openThreads, date = "2026-09-02") => ({
    date: new Date(`${date}T00:00:00+05:30`),
    headline: "Previous day.",
    state,
    openThreads,
});

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
[09:05] user (replying to the morning routine): ok fine
[14:20] user: fever went up, going to the hospital now
[19:40] user: they admitted me, overnight for observation. blood tests done, reports tomorrow
[19:42] user: told ankit the deck review has to move to monday
[21:15] user: watching loki in the hospital bed lol, actually pretty good
[23:14] user (replying to the night routine): barely ate, just hospital khichdi. spent 800 on the cab and admission. didn't touch the deck
[23:15] rasmalai (night routine): Logged: 1 meal (Dinner), Rs 800 on Health. Nothing on tasks.
`.trim(),
        checks: [
            { field: "state", must: /hospital|admitted/i, why: "tomorrow's schedule depends on knowing this" },
            { field: "openThreads", must: /blood test|report/i, why: "the thing to ask about tomorrow" },
            { field: "mentioned", must: /loki/i, why: "the passing detail with no other home" },
            { field: "mentioned", mustNot: /khichdi|\b800\b|spent|ate\b/i, why: "already in dietRegister and expenseRegister" },
            { field: "followThrough", must: /\w/, why: "a plan existed and was not followed" },
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
[09:41] user (replying to the morning routine): ok
[23:00] rasmalai (night routine): How was the day - what did you finish, eat, spend?
[23:52] user (replying to the night routine): honestly did nothing from the plan, got pulled into a prod issue all day. no gym. ordered food, 460
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
            { fn: (r) => JSON.stringify(r).length < 2200, why: "a dump must be compressed, not transcribed" },
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
];

export default SCENARIOS;
