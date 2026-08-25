import { BaseTool, ToolResult } from "../BaseTool.js";
import {
    getUserContext, forgetFacts, addFactKey, removeFactKey,
} from "../../../tools/mongo/operation/userFacts.js";
import { updateUserSettings, EDITABLE_SETTINGS } from "../../../tools/mongo/operation/userSettings.js";

/**
 * Tools for reading and editing who the user is.
 *
 * Only FetchUserContextTool belongs in the base registry. The rest are loaded by
 * the userContextEnrichment skill: they are rarer, they are destructive or
 * structural, and every declaration costs tokens on every request whether or not
 * the turn has anything to do with a profile.
 */

export class FetchUserContextTool extends BaseTool {
    static name = "fetchUserContext";
    static description =
        "Read the user's stored profile: every fact with its key, the vocabulary of keys available, and which of those keys they have nothing under yet. " +
        "The WHO YOU ARE HELPING block in your instructions is a readable summary and does NOT show keys — call this before changing anything, because updating a fact needs the exact key it is stored under. " +
        "Also useful when the user asks what you know about them, or you need to check whether something is already recorded.";
    static parameters = {
        type: "object",
        properties: {
            userId: { type: "integer", description: "Identifier of the user whose profile to read." },
        },
        required: ["userId"],
    };

    async execute({ userId }) {
        const context = await getUserContext(userId);
        return new ToolResult(
            true,
            `${context.facts.length} fact(s) stored; ${context.unused.length} known key(s) with nothing recorded.`,
            context
        );
    }
}

export class UpdateUserSettingsTool extends BaseTool {
    static name = "updateUserSettings";
    static description =
        "Change the user's typed settings — the ones the system itself acts on, as opposed to facts about them. " +
        "timezone decides when their daily routines fire, currency is the unit for every amount you log, morningHour and nightHour decide when the bot messages first. " +
        "Set only the fields you actually learned; omit the rest. Prefer inferring timezone and currency from where they say they live over asking directly.";
    static parameters = {
        type: "object",
        properties: {
            userId: { type: "integer", description: "Identifier of the user to update." },
            name: { type: "string", description: "What they want to be called." },
            timezone: { type: "string", description: "IANA zone, e.g. 'Asia/Kolkata'. Must be a real zone name, not an offset or a city alone." },
            currency: { type: "string", description: "ISO 4217 code they think in day to day, e.g. INR, USD, CAD." },
            locale: { type: "string", description: "BCP-47 tag, e.g. en-IN." },
            status: { type: "string", enum: ["active", "paused"], description: "'paused' stops routines without losing anything." },
            morningHour: { type: "integer", description: "Local hour (0-23) the morning routine should fire." },
            nightHour: { type: "integer", description: "Local hour (0-23) the evening routine should fire." },
        },
        required: ["userId"],
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

export class ForgetFactTool extends BaseTool {
    static name = "forgetFact";
    static description =
        "Permanently delete stored facts by key. Use when the user asks you to forget something, or when a fact turns out to be wrong rather than merely out of date. " +
        "If a fact has simply CHANGED — they moved, they finished the job hunt — use rememberFact instead, which replaces it and keeps the previous value. Deleting loses that history. " +
        "Call fetchUserContext first to get the exact keys.";
    static parameters = {
        type: "object",
        properties: {
            userId: { type: "integer", description: "Identifier of the user these facts belong to." },
            keys: {
                type: "array",
                description: "Exact fact keys to delete, e.g. ['work.employer'].",
                items: { type: "string" },
            },
        },
        required: ["userId", "keys"],
    };

    async execute({ userId, keys }) {
        const { removed, missing } = await forgetFacts(userId, keys);
        const parts = [];
        if (removed.length) parts.push(`Forgot: ${removed.join(", ")}`);
        if (missing.length) parts.push(`Not stored: ${missing.join(", ")}`);
        return new ToolResult(removed.length > 0, parts.join(". ") || "Nothing to forget.", { removed, missing });
    }
}

export class ManageFactKeyTool extends BaseTool {
    static name = "manageFactKey";
    static description =
        "Add or remove an entry in the shared vocabulary of fact keys — the categories the assistant knows are worth recording about anyone. " +
        "You do NOT need this to record a fact under a new key: rememberFact registers an unrecognised key by itself. Use this only to name a category before there is a fact for it, to improve a key's description, or to remove one that was a mistake. " +
        "Removal refuses while any user still has a fact under the key, and core keys cannot be removed at all.";
    static parameters = {
        type: "object",
        properties: {
            action: { type: "string", enum: ["add", "remove"], description: "What to do with the key." },
            key: { type: "string", description: "Lowercase dot-separated slug, e.g. 'education.certification'." },
            description: {
                type: "string",
                description: "Required for 'add'. What belongs under this key, written as guidance — this text is what a future extraction reads to decide whether a fact fits.",
            },
            userId: { type: "integer", description: "The user whose conversation prompted this, recorded on a new key." },
        },
        required: ["action", "key"],
    };

    async execute({ action, key, description, userId = null }) {
        const result = action === "remove"
            ? await removeFactKey(key)
            : await addFactKey(key, description, userId);

        return result.ok
            ? new ToolResult(true, `Key "${result.key}" ${result.action}.`, result)
            : new ToolResult(false, `Could not ${action} "${result.key}": ${result.reason}`, result);
    }
}
