/**
 * The skill for reviewing what the agent knows about someone, at any time.
 *
 * /start runs a structured review through the onboarding flow; this is the same
 * job in the middle of a conversation — "what do you know about me", "that's
 * out of date, I moved", "stop the night check-in". It carries
 * updateUserSettings, the one profile tool not declared on every turn, because
 * settings change rarely and code acts on every one of them.
 *
 * updateNotes stays declared outside it on purpose. Recording something said in
 * passing works because the tool is always there; behind a skill, every such
 * note would cost a round trip first.
 *
 * Everything here is deliberately absent from the base prompt. Its procedure is
 * only correct while a profile is actually being reviewed, and §7 records what
 * happens when procedural ceremony is always on: the model announced work it had
 * not done. Loaded on demand, it costs nothing on the turns it does not apply to.
 */

export default {
    name: "userContextEnrichment",

    // Shown in loadSkill's description — the only thing the model reads when
    // deciding whether to load this, so it has to say when, not what.
    summary:
        "Review or correct what you know about them, or change a setting the system acts on — timezone, currency, " +
        "check-in times, routines on or off. Load when they ask what you know about them, say something you have is " +
        "wrong or out of date, move somewhere, or want to be messaged at different times or not at all.",

    toolNames: ["updateUserSettings"],

    instruction: `
=====================================================================
SKILL — REVIEWING WHAT YOU KNOW ABOUT THEM
=====================================================================
You loaded this to go over what you know about them with them, correct
it, or change a setting the system acts on.

WHAT YOU HAVE
  WHO YOU ARE HELPING above is everything on file: their notes, and the
  line of settings under their name — timezone, currency, routines. Work
  from it. Never guess at what it says.

WHEN THEY ASK WHAT YOU KNOW
  Say it back in plain sentences, one area at a time — who they are,
  their day, what they are working towards — not as a list of section
  names. Then ask one thing: is anything wrong or missing?

WHEN SOMETHING IS WRONG OR OUT OF DATE
  Rewrite that section with updateNotes: the new detail in, the old one
  gone. A move is also a timezone and a currency — set them with
  updateUserSettings. Never ask for a timezone; nobody thinks of
  themselves as living in Asia/Kolkata. Anything you can derive, derive.

SETTINGS
  updateUserSettings   name, timezone, currency, locale, check-in times
                       (morningHour, nightHour), when their day rolls over
                       (dayStartHour), routines on or off.
    "stop the night check-in"   -> routines: false
    "plan at 7 instead"         -> morningHour: 7
    "I moved to Toronto"        -> timezone America/Toronto, currency CAD
  Routines cannot be switched on before onboarding is finished — the
  tool will say so; tell them it happens when onboarding ends.

ONE QUESTION AT A TIME
  Ask one thing, in the flow of the conversation, then wait. Two
  questions in a row is an interview and people stop answering.

THIS SKILL IS SUBORDINATE
  If a routine is in progress — a morning schedule, an evening wrap-up —
  that routine is the point of the conversation and this is not. Record
  what you learned, silently, and go straight back to it.

WHAT NOT TO STORE
  Anything that belongs in a register: an expense, a meal, a task, a
  reminder. A mood. A one-off. Guesses about health, money or
  relationships that the user did not actually state — if you are
  inferring, say so in the note.

HARD RULE 1 APPLIES
  A tool call has to have returned successfully before you say anything
  was saved.
`.trim(),
};
