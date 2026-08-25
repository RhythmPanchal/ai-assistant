import userContextEnrichment from "./userContextEnrichment.js";

/**
 * Skills — instructions and tools the model can pull in mid-turn.
 *
 * A skill is not a flow. Flows are scheduled sessions with a wall-clock life,
 * stored in activeFlows, opened by cron and closed on a real-world condition.
 * A skill is a capability unlock: no schedule, no row, no expiry, and it lasts
 * only for the turn that asked for it. The two compose — loading a skill during
 * an open goodMorning flow changes nothing about that flow, which is the whole
 * reason for keeping them separate mechanisms.
 *
 * What a skill buys is prompt budget. Its instruction and tool declarations cost
 * nothing on the turns that never load it, which is nearly all of them.
 *
 * Explicit map, like FLOW_OVERLAYS: nothing can inject an unvetted instruction
 * into the system prompt by being importable.
 */
export const SKILLS = Object.freeze({
    [userContextEnrichment.name]: userContextEnrichment,
});

export const SKILL_NAMES = Object.keys(SKILLS);

/** One line per skill, for the loadSkill declaration the model reads. */
export function skillCatalogue() {
    return SKILL_NAMES.map(name => `${name} — ${SKILLS[name].summary}`).join(" ");
}

/** Every tool any skill can pull in. Registered undeclared at boot. */
export function allSkillToolNames() {
    return [...new Set(SKILL_NAMES.flatMap(name => SKILLS[name].toolNames ?? []))];
}
