import { NOTE_SECTIONS } from "../../tools/mongo/schema/usersSchema.js";

const LABELS = Object.fromEntries(NOTE_SECTIONS.map(s => [s.key, s.label]));

// The guard is built before the flow object below exists.
const onboardingFlowType = "onboarding";

/**
 * Onboarding: getting to know someone new, or reviewing what is on file.
 *
 * Opened by userOnboardingJob on /start or on a new user's first message. Two
 * modes, decided in code from onboardedAt and handed to the model as a literal:
 *  - firstTime  never finished onboarding — learn the topics below
 *  - review     onboarded before — read back what is on file and correct it
 *
 * Everything learned is saved AS IT ARRIVES, with updateNotes and
 * updateUserSettings, straight onto the users document. Nothing is held back to
 * write at the end: there is no memory between two messages except the
 * database, so a buffer would be one more collection written every turn, and an
 * abandoned onboarding would lose everything instead of keeping what it got.
 *
 * Finishing it (completeFlow "done") is what marks them onboarded and switches
 * their routines on — see markOnboarded.
 */

/** Minutes without a message before an onboarding stops applying. Refreshed on every turn. */
export const ONBOARDING_IDLE_MINUTES = 15;

/**
 * The facts onboarding exists to collect, in the order they read naturally, and
 * where each one is saved. `saves` names a notes section, or `settings`.
 *
 * Age leads because the rest branches on it: a 12-year-old gets asked about
 * school and what they want to become, a 20-year-old about college and what
 * comes after it.
 */
export const ONBOARDING_TOPICS = Object.freeze([
    { key: "age",        saves: "about",          learn: "how old they are" },
    { key: "occupation", saves: "about",          learn: "school, college or work — and which: class and school, course and college, or role and company" },
    { key: "detail",     saves: "about",          learn: "one level deeper on that — favourite subjects at school, year and branch at college, field and team at work" },
    { key: "home",       saves: "about",          learn: "where they live — which also gives you their timezone and currency" },
    { key: "household",  saves: "about",          learn: "who they live with — family, roommates, hostel, alone" },
    { key: "day",        saves: "routine",        learn: "a normal day — when they wake, sleep, and are at school, college or work" },
    { key: "checkIns",   saves: "settings",       learn: "whether a morning plan at 09:00 and a night check-in at 23:00 suit them, other times, or none at all" },
    { key: "health",     saves: "about",          learn: "food they don't eat, allergies, or health things you should keep in mind" },
    { key: "nearGoal",   saves: "shortTermGoals", learn: "something to get done in the next few months — exams, an internship, a project, a skill" },
    { key: "ambition",   saves: "longTermGoals",  learn: "what they want to become, or where they want to be in a few years" },
    { key: "habit",      saves: "habits",         learn: "one habit they want to build or keep" },
    { key: "push",       saves: "behaviour",      learn: "when they slip — a gentle nudge, or said straight" },
]);

/** What a section holds when they would rather not answer. */
export const PLACEHOLDER = "Prefers not to say.";

// A note that tells you nothing about them: the placeholder, and the fillers a
// model reaches for instead. In the fifth live run "None." went into habits and
// behaviour, neither ever asked, and onboarding closed on it. Whole-note only —
// "No sugar." and "None of the above, works nights." are answers.
const SAYS_NOTHING = /^\s*(prefers? not to say|(none|nothing)( (yet|so far|given|mentioned|specified|shared))?|n\/?a|nil|unknown|tbd|-+|not (specified|provided|mentioned|shared|given|known|asked|discussed|stated)( yet)?|no ([\w-]+ ){0,3}(mentioned|given|specified|shared|provided|noted|stated)( yet)?|no ([\w-]+ ){1,3}yet)\s*[.!]*\s*$/i;

/** Whether a note records no answer at all — a skip, whatever words it uses. */
export const saysNothing = (text) => SAYS_NOTHING.test(String(text ?? ""));

// Phrases anywhere, single words only as the whole message: "pass" alone
// declines, "I want to pass my exams" does not; "skip" alone declines, "I
// skip breakfast" does not. A false match lets the model skip one more topic.
const DECLINE_PHRASE = /(\bi'?d )?\brather not\b|\bprefer not to\b|\bdon'?t (want|wish) to (say|share|answer|talk)\b|\bnot comfortable (sharing|saying|answering)\b|\bno comment\b|\bnone of your business\b|\bnext question\b|\b(let'?s|can we) move on\b|\bskip (this|that|it)( one)?\b|\bpass on (this|that)\b/i;
const DECLINE_WORD = /^\s*(skip|pass|next)\s*[.!]*\s*$/i;
// "none" or "nothing" as the whole reply tells you there is nothing to tell, and
// may leave a section saying so. Bare "no" does not: it answers yes/no questions.
const NOTHING_TO_TELL = /^\s*(none|nothing( really| much)?|not really|nah|n\/?a|nil)\s*[.!]*\s*$/i;
const STOP_ALL = /\b(skip|no more|enough)( with)?( the)? (rest|questions)\b|\bstop asking\b|\bthat'?s enough( questions)?\b/i;

/**
 * Whether a message turns a question down, or says there is nothing to tell —
 * read by CODE from their actual words, because createSkipGuard lets a note
 * saying nothing be saved only in reply to one. stopAll covers "skip the rest"
 * and "enough questions".
 */
export function classifyReply(text) {
    const t = String(text ?? "");
    const stopAll = STOP_ALL.test(t);
    return { declined: stopAll || DECLINE_PHRASE.test(t) || DECLINE_WORD.test(t) || NOTHING_TO_TELL.test(t), stopAll };
}

/**
 * Keeps "Prefers not to say." to the questions they actually turned down.
 *
 * A skip fills a section, and only filled sections let onboarding finish, so a
 * model in a hurry writes one for topics it never asked. The live evals caught
 * it four ways: one "I'd rather not say" written into four sections, skips
 * written in turns where they had answered, "be gentle" overwritten with one,
 * and — once "Prefers not to say." was guarded — "None." instead. Counting
 * declines when onboarding finished let the first three through — one decline
 * paid for a skip anywhere, and nothing stopped an answer being replaced — so
 * each write of a note saying nothing (saysNothing) is checked against the
 * message this turn answers:
 *  - only in a turn whose message turned something down
 *  - one section per decline, unless they asked to skip the rest
 *  - never over a section holding an answer, from before or from this turn
 *
 * It also keeps onboarding itself from being skipped by someone answering. A
 * model counts a reply that was not an answer to ITS question as unrelated —
 * "those times are fine" while it was asking about subjects — and on the
 * second one closes the onboarding as skipped: the seventh run did that to a
 * 12-year-old in the middle of telling it about themselves. So a turn that has
 * saved something about them may not close onboarding as skipped.
 *
 * `reply` is classifyReply of the person's message; a job's trigger turns
 * nothing down. `notes` are the users document's notes as the turn began.
 * check(call) returns null to let the call run, or why it may not; record(call,
 * result) is told what each call did, once it has run.
 */
export function createSkipGuard({ reply = { declined: false, stopAll: false }, notes = null } = {}) {
    const answered = new Set(NOTE_SECTIONS
        .filter(({ key }) => notes?.[key]?.text && !saysNothing(notes[key].text))
        .map(({ key }) => key));
    let skips = 0;
    // What this turn has saved about them, if anything — a note or a setting.
    let learned = null;

    return {
        check({ name, args } = {}) {
            if (name === "completeFlow") {
                if (args?.flowType !== onboardingFlowType || args?.reason !== "skipped" || !learned || reply.stopAll) return null;
                return `their message told you about them — ${learned} was saved — so it is an answer, not an unrelated reply, ` +
                    `even if it was not what you asked. Do not count it. Ask your next question.`;
            }
            if (name !== "updateNotes") return null;
            const { section, text } = args ?? {};
            if (!saysNothing(text)) {
                if (text) answered.add(section);
                return null;
            }
            const label = LABELS[section] ?? section;
            if (answered.has(section)) return `${label} already holds their answer, and a note saying nothing never replaces one.`;
            if (!reply.declined) {
                return `"${text}" says nothing, which is only for a question they turned down — and they turned nothing down in this message. Ask about ${label} instead.`;
            }
            if (!reply.stopAll && skips >= 1) return `they turned down one question, so only one topic may say nothing. Ask about ${label}.`;
            skips++;
            return null;
        },

        record({ name, args } = {}, result) {
            if (!result?.success) return;
            if (name === "updateNotes" && !saysNothing(args?.text) && result.data?.action !== "unchanged") {
                learned ??= LABELS[args?.section] ?? "a note";
            }
            if (name === "updateUserSettings") learned ??= "a setting";
        },
    };
}

/**
 * The note sections that are still empty — what stops onboarding from finishing.
 *
 * The live eval had flash-lite models read back and close after seven or eight
 * answers in four of six onboardings, with long-term goals, habits and behaviour
 * never asked, despite an instruction to cover every topic. So finishing is
 * gated in code on this: every section must hold SOMETHING. A topic they turn
 * down is saved as "Prefers not to say." — only in reply to that, see
 * createSkipGuard — which also stops a later review from asking it again.
 *
 * Only the six sections gate. Topics inside about (household, health) and the
 * settings are left to the model; an unasked check-in time just means the
 * defaults, which is what routines on by default already promises.
 */
export function unfinishedSections(profile) {
    return NOTE_SECTIONS.filter(({ key }) => !profile?.notes?.[key]?.text).map(({ label }) => label);
}

/** What is still empty on file, worked out in code — the model reads it, never computes it. */
export function stillEmpty(profile) {
    const empty = NOTE_SECTIONS
        .filter(({ key }) => !profile?.notes?.[key]?.text)
        .map(({ label }) => label);

    const prefs = profile?.preferences ?? {};
    const timesChosen = prefs.routinesChosenAt || prefs.morningHour != null || prefs.nightHour != null;
    if (!timesChosen) empty.push("check-in times");
    if (!profile?.currency) empty.push("currency");

    return empty;
}

/**
 * The live half of the overlay, rebuilt every turn: which mode this is, and what
 * is still empty. Built from the profile runAgent already loaded, so it costs no
 * query of its own.
 */
export function buildOnboardingContext(userId, { profile = null } = {}) {
    const mode = profile?.onboardedAt ? "review" : "firstTime";
    const empty = stillEmpty(profile);
    const unfinished = unfinishedSections(profile);

    return [
        "-------------------------------------",
        `🧭 ONBOARDING STATE`,
        `- MODE: ${mode === "review"
            ? "review — they were onboarded before; check what is on file with them"
            : "firstTime — getting to know them"}`,
        `- STILL EMPTY: ${empty.length ? empty.join(", ") : "nothing — every section and setting has something"}`,
        unfinished.length
            ? `- NOT READY TO FINISH: ask about ${unfinished.join(", ")}.`
            : "- READY TO FINISH: every section has a note — read back and complete.",
        "-------------------------------------",
    ].join("\n");
}

const TRIGGER = {
    firstTime: "[onboarding] Ask your first question.",
    review: "[onboarding] They sent /start. Begin the review.",
};

export function buildOnboardingTriggerPrompt(mode = "firstTime") {
    return TRIGGER[mode] ?? TRIGGER.firstTime;
}

const topicLines = ONBOARDING_TOPICS
    .map((t, i) => `  ${String(i + 1).padStart(2)}. ${t.learn}\n      -> ${t.saves}`)
    .join("\n");

export const onboardingFlow = {
    flowType: onboardingFlowType,

    /**
     * Idle, not wall-clock: every turn pushes this forward, so it ends fifteen
     * minutes after they stop replying. A fixed window from /start would end the
     * onboarding under someone still answering question nine.
     */
    idleMinutes: ONBOARDING_IDLE_MINUTES,
    computeExpiry: (_timeZone, now = new Date()) => new Date(now.getTime() + ONBOARDING_IDLE_MINUTES * 60 * 1000),

    buildTriggerPrompt: buildOnboardingTriggerPrompt,
    buildContext: buildOnboardingContext,

    /**
     * Declared for this flow's turns only. Settings are skill-loaded everywhere
     * else, but onboarding sets a timezone and check-in times on nearly every
     * run, and a skill round trip in front of each would be pure waste.
     */
    toolNames: ["updateUserSettings"],

    instruction: `
-------------------------------------
🧭 ACTIVE FLOW: ONBOARDING
-------------------------------------
You are getting to know this person (MODE firstTime) or checking what you
know with them (MODE review) — see ONBOARDING STATE below. Everything you
learn is saved AS YOU GO. Nothing is kept for the end.

-------------------------------------
THE FIRST QUESTION — when the latest message is "[onboarding] ..."
-------------------------------------
That message comes from the system, not the person. Call NO tools.
firstTime: they were just sent a welcome that explains what you do and uses
  their Telegram name. Do not repeat it. Ask your first question — usually
  how old they are.
review: say in two or three plain sentences what you have on file for them,
  then ask if it is still right.

🛑 ABSOLUTE RULE — TOOLS BEFORE TEXT
Before writing your reply, save everything their latest message told you:
  about, routine, habits, goals, behaviour → updateNotes, the whole section
                                             with the new detail merged in
  where they live   → updateUserSettings: timezone and currency, derived —
                      never ask for them. Even in passing: "a college in
                      Pune" is where they live.
  check-in times    → updateUserSettings: morningHour and nightHour — save
                      them even when they keep 09:00 and 23:00
  no daily messages → updateUserSettings: routines false
Routines switch on by themselves when onboarding finishes. Never try to turn
them on.
Save silently: no "noted", no "I've updated". The next question is the reply.

WHAT TO LEARN (firstTime) — in roughly this order
${topicLines}

ONE QUESTION PER MESSAGE
  At most one short line reacting to what they said, then ONE question.
  Never two topics in one message, even joined by "and":
    Not: "Where do you work, and what does your week look like?"
    Yes: "Where do you work?"

TAKE EVERYTHING AN ANSWER GIVES YOU
  "I'm 20, 3rd year CSE at NIT Surat, want to work abroad" answers age,
  college, year and ambition in one go. Save all of it and move past every
  topic it covered. Never ask for something WHO YOU ARE HELPING already says.

BRANCH ON WHAT YOU LEARN — and confirm instead of assuming
  around 10-17 → school: which school and class, favourite subjects,
                 what they want to become
  around 17-24 → college: which college, course and year, what they want
                 to do after — a job, higher studies, abroad
  working      → role and company, what they work on, where their career
                 is heading
  "So you're in college?" beats guessing.

"SKIP" MEANS SKIP — THEIRS, NEVER YOURS
  When they turn your question down ("I'd rather not say", "skip"), save
  "Prefers not to say." as the whole note of THAT topic's section if it is
  still empty, go to the next topic, and never ask it again. Turning down
  check-in times changes no note — keep the defaults. A section you have
  not asked about is never filled with "None.", "N/A" or anything else
  that says nothing: those are skips too, refused in a message that turned
  nothing down, for a second section, and over anything they told you.

IF THEY SAY SOMETHING ELSE
  Anything about themselves is an answer, even when it is not what you
  asked — "I don't eat eggs" while you asked about school. Save it, move
  past what it covered, and never count it. Only a message that is not
  about them at all — a meal to log, a reminder, a question for you — is
  something else: handle it properly first, then ask your next question in
  the same reply, and record it with
  updateFlowScratchpad { unrelatedReplies: <FLOW STATE count + 1> }.
  If FLOW STATE already shows 1, this is the second: do not ask again —
  completeFlow with reason "skipped", and say they can send /start any
  time to finish.

REVIEW MODE
  Go one area at a time — who they are, their day, what they are working
  towards — "I have you as a nurse in Nagpur on night shifts. Still right?"
  Save what changed by REWRITING the section to say only what is true now:
    "Teacher in Surat." — not "Teacher in Jaipur. Moved to Surat."
  Something filed in the wrong section — a situation under Routine — moves
  to the section it belongs in.
  Then ask about whatever is STILL EMPTY. Then ask if there is anything new.

FINISHING — only when ONBOARDING STATE says READY TO FINISH
  Not before. While it says NOT READY TO FINISH, ask about the next empty
  section; completeFlow refuses until every section has a note.
  When ready: send a short readback of what you now know — plain lines, no
  section names — end with "If anything's wrong, just tell me", and call
  completeFlow with flowType "onboarding" and reason "done" in the SAME
  reply. Do not wait for them to confirm. Say what its result says about
  their routines, and nothing more.
  If they ask to stop ("skip the rest", "enough questions"): save
  "Prefers not to say." for every section still empty, then finish as above.
`.trim(),
};

export default onboardingFlow;
