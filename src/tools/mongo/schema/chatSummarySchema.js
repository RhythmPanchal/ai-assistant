export const CHAT_SUMMARY = "chatSummary";

/**
 * What the agent remembers about a day once that day's raw chat has aged out.
 *
 * chatHistory is scoped to the current day — it has to be, a raw week is ~10K
 * tokens, larger than the entire system prompt. So at midnight the agent forgets
 * everything: told on Wednesday that the user was in hospital, on Thursday it
 * cheerfully proposed a cardio-heavy schedule. This collection is the layer that
 * survives that reset.
 *
 * The important design point is that a row is NOT a recap of one day in
 * isolation. `state` and `openThreads` are CARRIED FORWARD from the previous
 * day's row and pruned as things resolve, so the newest row always holds
 * everything currently true — whichever day it started on. That is what lets the
 * prompt inject one full row plus a week of bare headlines and still lose
 * nothing: a commitment made on Monday is still in Thursday's `state`.
 *
 * The split between this and userFact is episodic vs durable. "Vegetarian" is a
 * fact and belongs in the profile block, asserted forever. "Advised rest until
 * Sunday" is a state — true now, false next week, and never worth asserting
 * again after it lapses. Writing the second kind into userFact is how the prompt
 * ends up insisting someone is still job hunting a year later.
 */
const chatSummarySchema = {
  title: "chatSummary",
  description:
    "Rolling episodic memory of a user's conversations. One row per period per user. " +
    "state and openThreads carry forward from the previous row; headline, mentioned and mood belong to that period alone.",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: "int",
      description: "Internal user id (users.userId), not a channel id.",
    },

    // Only "day" is produced today. week/month are declared now so the rollup
    // jobs can land without a schema migration and, more importantly, so the
    // unique index below already has the right shape for them.
    period: {
      bsonType: "string",
      description: "Which span this row covers. Only 'day' is written today.",
      enum: ["day", "week", "month"],
    },

    // Named `date` to match every other day-scoped collection here
    // (dietRegister, taskRegister, userSchedule), so normalizeDates and the
    // fetchRecord conventions apply without a special case.
    //
    // For a day row this is the day covered — which is NOT the day the row was
    // written. The wrap-up that feeds it routinely finishes after midnight, and
    // the no-reply path writes at 09:00 the next morning.
    date: {
      bsonType: "date",
      description:
        "The local day this row covers. For a week or month row, its first day. Bare 'YYYY-MM-DD' — never the day the summary was written.",
    },

    // One to three sentences rather than one. The headline is read EIGHT times
    // — rendered in full for the newest day, and as the only line for each of
    // the seven days behind it — so it is the one field whose length multiplies.
    // Everything else in the row is read once. Detail about the most recent day
    // is not scarce even so: state, openThreads and followThrough already give
    // it a paragraph, and they are the fields to widen if it needs more.
    headline: {
      bsonType: "string",
      description:
        "One to three sentences: what this day was. Belongs to this day only and is never carried forward — it is the single line rendered for older days in the prompt, so it has to stand alone with no other context around it.",
    },

    // Arrays of plain sentences rather than structured objects on purpose. The
    // consumer is a language model reading mid-prompt, not a query — every
    // field we could filter on is already a real column somewhere else.
    state: {
      bsonType: "array",
      description:
        "What is true about the user right now and is not held by any register — 'discharged Thu, no exertion until Sun 7th'. Carried forward from the previous row and dropped once it stops being true.",
      items: { bsonType: "string" },
    },

    openThreads: {
      bsonType: "array",
      description:
        "Unresolved things the agent should be able to follow up on — 'waiting on blood test results'. Carried forward until closed or no longer relevant.",
      items: { bsonType: "string" },
    },

    mentioned: {
      bsonType: "array",
      description:
        "Passing detail worth being able to recall — 'watching Loki, enjoying it'. Never carried forward: it is flavour, not state, and carrying it would grow without bound.",
      items: { bsonType: "string" },
    },

    // The founding point of this assistant is follow-through, so the one thing
    // it must never lose is whether the plan actually happened. Everything else
    // here is context; this is the accountability.
    followThrough: {
      bsonType: ["string", "null"],
      description: "One line of planned vs actual — 'planned gym + deck work, did neither, sick from midday'. Null when nothing was planned.",
    },

    mood: {
      bsonType: ["string", "null"],
      description: "A few words at most. Belongs to this day only.",
    },

    createdAt: { bsonType: "date" },
  },

  required: ["userId", "period", "date", "headline"],
};

export default chatSummarySchema;

/**
 * Serves both reads and the write:
 *  - the prompt render — find({ userId, period: "day", date: {$gte} })
 *                        .sort({ date: -1 }).limit(8), once per agent turn
 *  - carry-forward     — the previous day's row, read by the summarize overlay
 *  - the write guard   — see below
 *
 * unique is load-bearing, not an optimisation. The summarize pass can be
 * entered twice for one day: the agent closes the goodNight flow at 23:40, and
 * if that write is ever missed the morning job's supersede path queues it again
 * at 09:00. The job guards on an existing row, but a guard is a read-then-write
 * race and this is the half that cannot lose it. Second insert fails, the tool
 * returns the error to the model, and the day keeps exactly one summary.
 *
 * date descending matches the render's sort, so the limit stops after reading
 * as many index entries as it needs.
 */
export const CHAT_SUMMARY_INDEXES = [
  { key: { userId: 1, period: 1, date: -1 }, name: "userId_1_period_1_date_-1", unique: true },
];
