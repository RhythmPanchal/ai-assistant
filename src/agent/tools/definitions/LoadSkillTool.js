import { BaseTool, ToolResult } from "../BaseTool.js";
import { SKILLS, SKILL_NAMES, skillCatalogue } from "../../skills/index.js";

/**
 * The one always-present tool that can widen a turn.
 *
 * Its result carries the skill's instruction and tool names; runAgent reads them
 * off the ToolResult and applies them to the rest of the loop. The tool itself
 * touches nothing — keeping it inert means the registry stays a plain
 * name-to-tool map and the only code that mutates a turn is the loop that owns
 * that turn.
 */
export class LoadSkillTool extends BaseTool {
    static name = "loadSkill";
    static description =
        "Load a skill: extra instructions and tools for a specific job, available for the rest of this reply. " +
        `Available skills — ${skillCatalogue()} ` +
        "Load one as soon as you know you need it; you can use its tools immediately, in this same reply. " +
        "Do not load a skill speculatively — if you only need to record one thing the user stated, rememberFact on its own is enough.";
    static parameters = {
        type: "object",
        properties: {
            skill: {
                type: "string",
                enum: SKILL_NAMES,
                description: "Which skill to load.",
            },
        },
        required: ["skill"],
    };

    async execute({ skill }) {
        const definition = SKILLS[skill];
        if (!definition) {
            return new ToolResult(false, `Unknown skill '${skill}'. Available: ${SKILL_NAMES.join(", ")}`);
        }

        return new ToolResult(
            true,
            `Loaded ${skill}. Its instructions and tools are available now — continue in this reply.`,
            { skill, instruction: definition.instruction, toolNames: definition.toolNames ?? [] }
        );
    }
}
