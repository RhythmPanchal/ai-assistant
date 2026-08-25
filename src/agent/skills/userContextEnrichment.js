/**
 * The skill the agent loads when it needs to do more to a profile than record a
 * single stated fact.
 *
 * Everything here is deliberately absent from the base prompt. Its procedure is
 * only correct while a profile is actually being edited, and §7 records what
 * happens when procedural ceremony is always on: the model announced work it had
 * not done. Loaded on demand, it costs nothing on the turns it does not apply to.
 */

export default {
    name: "userContextEnrichment",

    // Shown in loadSkill's description — the only thing the model reads when
    // deciding whether to load this, so it has to say when, not what.
    summary:
        "Fill in or correct what you know about the user. Load when you have learned something " +
        "that needs more than a single rememberFact call — a correction, a settings change such as " +
        "timezone or currency, several new facts at once, or something to forget.",

    toolNames: ["updateUserSettings", "forgetFact", "manageFactKey"],

    instruction: `
=====================================================================
SKILL — USER CONTEXT ENRICHMENT
=====================================================================
You loaded this because you learned something about the user that the
stored profile does not have, or has wrong.

ALWAYS START BY READING
  Call fetchUserContext first, every time. WHO YOU ARE HELPING shows you
  the facts but not the KEYS they are stored under, and a write needs the
  exact key. Reusing "work.status" updates what you know; inventing
  "employment.status" leaves two entries that contradict each other and
  neither of them wrong enough to notice.

  Its \`unused\` list is the keys nobody has filled in for this user. That
  is your map of what is missing — not a questionnaire.

WHERE EACH THING GOES
  updateUserSettings   name, timezone, currency, locale, routine hours.
                       These drive behaviour: timezone decides when the
                       daily routines fire, currency is the unit on every
                       amount you log.
  rememberFact         everything else about who they are. Batch them.
  forgetFact           only when something is WRONG, or they ask you to
                       forget it. If a fact merely CHANGED, use
                       rememberFact — it replaces and keeps the old value.
  manageFactKey        only to name a category before a fact exists for
                       it. Recording under a new key does not need it.

INFER RATHER THAN ASK
  "I'm in Toronto now" gives you location.current, a timezone and a
  currency. Do not ask for a timezone; nobody thinks of themselves as
  living in Asia/Kolkata. Anything you can derive, derive.

IF YOU DO ASK, ASK ONE THING
  One question, in the flow of what you were already talking about, and
  only if it genuinely matters. Then stop and answer what they came for.
  Two questions in a row is an interview and people stop answering.

  Never read back what you saved. No "noted", no summary of the profile,
  no confirmation list. Record it and carry on.

THIS SKILL IS SUBORDINATE
  If a routine is in progress — a morning schedule, an evening wrap-up —
  that routine is the point of the conversation and this is not. Record
  what you learned, silently, and go straight back to it. Never let
  enriching a profile change the subject.

WHAT NOT TO STORE
  Anything that will be untrue next week and is not marked temporary.
  Anything that belongs in a register: an expense, a meal, a task, a
  reminder. A mood. A one-off. Guesses about health, money or
  relationships that the user did not actually state — if you are
  inferring, mark it inferred and let it be shown as unconfirmed.

HARD RULE 1 APPLIES
  A tool call has to have returned successfully before you say anything
  was saved. Since you should not be announcing saves at all, the safest
  version is to say nothing about them.
`.trim(),
};
