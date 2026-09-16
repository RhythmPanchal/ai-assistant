import { BaseTool, ToolResult } from "../BaseTool.js";
import { updateNoteSection } from "../../../tools/mongo/operation/userNotes.js";
import { updateUserSettings, EDITABLE_SETTINGS } from "../../../tools/mongo/operation/userSettings.js";
import { NOTE_SECTIONS, NOTE_SECTION_LIMIT } from "../../../tools/mongo/schema/usersSchema.js";

/**
 * The two ways the model edits a profile, split by who reads the result.
 *
 * updateNotes writes prose only the model reads back, so it can be loose and is
 * declared on every turn. updateUserSettings writes fields the SYSTEM acts on —
 * a wrong timezone fires every routine at the wrong hour — so it is validated
 * field by field and loaded only with the userContextEnrichment skill.
 */

const LABELS = Object.fromEntries(NOTE_SECTIONS.map(s => [s.key, s.label]));

export class UpdateNotesTool extends BaseTool {
    static name = "updateNotes";
    static description =
        "Rewrite one section of your notes about the user — the sections of WHO YOU ARE HELPING. " +
        "The text REPLACES the section: write it out whole with the new detail merged in and anything no longer true left out. " +
        "Only what will still matter next week — an expense, a meal or a task belongs in its own register, not here. " +
        "If something new pulls against what the section already says, keep both and say they conflict; never quietly drop the old one. " +
        "To forget something, rewrite the section without it. Never tell them you saved a note.";
    static parameters = {
        type: "object",
        properties: {
            section: {
                type: "string",
                enum: NOTE_SECTIONS.map(s => s.key),
                // Built from the schema's own list, so the model is told what each
                // section holds in exactly the words the rest of the code uses.
                description: NOTE_SECTIONS.map(s => `${s.key} — ${s.holds}`).join("; ") + ".",
            },
            text: {
                type: "string",
                description: `The whole section in plain sentences, at most ${NOTE_SECTION_LIMIT} characters. An empty string clears it.`,
            },
        },
        required: ["section", "text"],
    };

    async execute({ userId, section, text }) {
        const result = await updateNoteSection(userId, section, text);
        if (!result.ok) {
            // Returned so the model reads the reason and rewrites shorter, rather
            // than believing the note landed.
            return new ToolResult(false, `Not saved: ${result.reason}`, result);
        }
        return new ToolResult(true, `${LABELS[section]} ${result.action}.`, result);
    }
}

export class UpdateUserSettingsTool extends BaseTool {
    static name = "updateUserSettings";
    static description =
        "Change the user's typed settings — the ones the system itself acts on, as opposed to notes about them. " +
        "timezone decides when their daily routines fire, currency is the unit for every amount you log, morningHour and nightHour decide when the bot messages first. " +
        "Set only the fields you actually learned; omit the rest. Prefer inferring timezone and currency from where they say they live over asking directly.";
    static parameters = {
        type: "object",
        properties: {
            name: { type: "string", description: "What they want to be called." },
            timezone: { type: "string", description: "IANA zone, e.g. 'Asia/Kolkata'. Must be a real zone name, not an offset or a city alone." },
            currency: { type: "string", description: "ISO 4217 code they think in day to day, e.g. INR, USD, CAD." },
            locale: { type: "string", description: "BCP-47 tag, e.g. en-IN." },
            status: { type: "string", enum: ["active", "paused"], description: "'paused' stops routines without losing anything." },
            morningHour: { type: "integer", description: "Local hour (0-23) the morning routine should fire." },
            nightHour: { type: "integer", description: "Local hour (0-23) the evening routine should fire." },
        },
        required: [],
    };

    async execute({ userId, ...settings }) {
        const { applied, rejected } = await updateUserSettings(userId, settings);

        const changed = Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing";
        if (rejected.length) {
            // Returned rather than swallowed so the model can correct a bad
            // timezone itself instead of believing it was saved.
            return new ToolResult(
                Object.keys(applied).length > 0,
                `Updated: ${changed}. Rejected: ${rejected.map(r => `${r.field} — ${r.reason}`).join("; ")}`,
                { applied, rejected, editable: EDITABLE_SETTINGS }
            );
        }
        return new ToolResult(true, `Updated: ${changed}.`, { applied });
    }
}
