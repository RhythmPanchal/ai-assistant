import { getDB } from "../mongoClient.js";
import { USERS } from "../schema/usersSchema.js";

/**
 * Typed settings on the users document — the half of a profile that CODE reads.
 *
 * Separate from the notes on purpose. Notes are prose only the model reads
 * back and can be wrong without breaking anything; these fields drive
 * behaviour. timezone decides when routines fire, currency is the unit on every
 * amount in expenseRegister, morningHour and nightHour decide when the bot
 * speaks first. A wrong value here is silent and lasting, so each one is
 * validated rather than trusted.
 */

const EDITABLE = ["name", "timezone", "currency", "locale", "status", "morningHour", "nightHour", "dayStartHour", "routines", "llmTrace"];

// Where a setting lives on the users document when it is not a top-level field.
// initCron reads the hours and the opt-in from preferences, so a top-level write
// would be stored and never read.
const PATHS = {
    morningHour: "preferences.morningHour",
    nightHour: "preferences.nightHour",
    dayStartHour: "preferences.dayStartHour",
    routines: "preferences.triggersOptIn",
    // Debug-only, and absent from the updateUserSettings declaration on
    // purpose: an operator turns tracing on from the console, the model has no
    // reason to and no way to.
    llmTrace: "preferences.llmTrace",
};

const STATUSES = ["active", "paused"];

/**
 * A timezone the runtime cannot resolve is the worst field to get wrong: every
 * routine for that user silently stops firing at the right hour and nothing
 * reports it.
 *
 * Intl alone is not a sufficient test. It ACCEPTS bare abbreviations — IST, PST,
 * EST, GMT — and resolves them against whatever ICU happens to think they mean,
 * which for IST is any of India, Ireland or Israel depending on build. A model
 * writing "IST" would look correct here and silently pick a timezone.
 *
 * Intl.supportedValuesOf cannot be used as an allowlist either: it returns only
 * canonical names, and Node canonicalises Asia/Kolkata to Asia/Calcutta, so the
 * zone this entire codebase is written around is absent from it. UTC is missing
 * too.
 *
 * So: Intl must accept it, AND it must be in Region/City form or be UTC. That
 * admits Asia/Kolkata, Asia/Calcutta, America/Toronto and UTC while rejecting
 * every ambiguous abbreviation.
 *
 * The value is stored as given, NOT canonicalised. Rewriting Asia/Kolkata to
 * Asia/Calcutta on save would leave stored zones disagreeing with the
 * IST_TIMEZONE literal used throughout the code for no behavioural gain.
 */
function validTimezone(tz) {
    if (typeof tz !== "string") return false;
    if (tz !== "UTC" && !tz.includes("/")) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function validateField(field, value) {
    switch (field) {
        case "name": {
            const name = String(value ?? "").trim();
            if (!name) return { ok: false, reason: "name cannot be empty" };
            if (name.length > 80) return { ok: false, reason: "name is unreasonably long" };
            return { ok: true, value: name };
        }
        case "timezone": {
            const tz = String(value ?? "").trim();
            if (!validTimezone(tz)) {
                return {
                    ok: false,
                    reason: `"${tz}" is not an IANA timezone — use a Region/City name like "Asia/Kolkata". ` +
                            `Abbreviations such as IST or PST are ambiguous and are not accepted.`,
                };
            }
            return { ok: true, value: tz };
        }
        case "currency": {
            const code = String(value ?? "").trim().toUpperCase();
            if (!/^[A-Z]{3}$/.test(code)) {
                return { ok: false, reason: `"${value}" is not a 3-letter ISO 4217 code — e.g. INR, USD, CAD` };
            }
            return { ok: true, value: code };
        }
        case "locale": {
            const tag = String(value ?? "").trim();
            if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) {
                return { ok: false, reason: `"${value}" is not a BCP-47 tag — e.g. en-IN` };
            }
            return { ok: true, value: tag };
        }
        case "status": {
            const status = String(value ?? "").trim().toLowerCase();
            if (!STATUSES.includes(status)) {
                return { ok: false, reason: `status must be one of ${STATUSES.join(", ")}` };
            }
            return { ok: true, value: status };
        }
        case "llmTrace": {
            if (typeof value !== "boolean") {
                return { ok: false, reason: "llmTrace must be true or false" };
            }
            return { ok: true, value };
        }
        case "routines": {
            // Strictly a boolean. "yes", 1 and "true" all arrive from models that
            // were told the field is boolean; guessing what they meant is how a
            // routine switches on for someone who asked for it to stop.
            if (typeof value !== "boolean") {
                return { ok: false, reason: "routines must be true or false" };
            }
            return { ok: true, value };
        }
        case "morningHour":
        case "nightHour":
        case "dayStartHour": {
            const hour = Number(value);
            if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
                return { ok: false, reason: `${field} must be a whole hour from 0 to 23 in the user's own time` };
            }
            return { ok: true, value: hour };
        }
        default:
            return { ok: false, reason: `not an editable setting — editable: ${EDITABLE.join(", ")}` };
    }
}

/**
 * Validate and normalise a partial settings object. Pure — no database — so the
 * rules above can be tested directly, and so a fully invalid payload never opens
 * a connection.
 *
 * Returns the Mongo-shaped `update` alongside the caller-facing `applied`,
 * because the two differ: routine hours nest under preferences.
 */
export function validateSettings(settings = {}, { now = new Date() } = {}) {
    const applied = {};
    const rejected = [];
    const update = {};

    for (const [field, value] of Object.entries(settings)) {
        if (value === undefined || value === null) continue;

        const check = validateField(field, value);
        if (!check.ok) {
            rejected.push({ field, reason: check.reason });
            continue;
        }

        update[PATHS[field] ?? field] = check.value;
        applied[field] = check.value;

        // Turning routines on or off is a CHOICE, and it is recorded as one.
        // Onboarding switches routines on when it finishes; this is what stops
        // that from overriding someone who already said no.
        if (field === "routines") update["preferences.routinesChosenAt"] = now;
    }

    return { applied, rejected, update };
}

/**
 * Routines are messages nobody asked for, so they stay off until onboarding is
 * done — its completion is what switches them on. Before that, a request to turn
 * them ON is refused with the reason; everything else in the same call still
 * applies, so check-in times set during onboarding land. Turning them OFF is
 * always allowed.
 *
 * Pure, so the rule is tested without a database.
 */
export function holdRoutinesUntilOnboarded(result, user) {
    if (result.update["preferences.triggersOptIn"] !== true || user?.onboardedAt) return result;

    const update = { ...result.update };
    delete update["preferences.triggersOptIn"];
    delete update["preferences.routinesChosenAt"];
    const { routines, ...applied } = result.applied;

    return {
        applied,
        update,
        rejected: [...result.rejected, {
            field: "routines",
            reason: "routines switch on by themselves when onboarding finishes — there is nothing to turn on yet. " +
                    "Set morningHour or nightHour if they want different times.",
        }],
    };
}

/**
 * Apply a partial update. Returns what changed and what was refused, so a caller
 * can report the refusal rather than assume the write landed.
 *
 * Partial by design: the model should be able to set a timezone it just learned
 * without restating everything else it does not know.
 */
export async function updateUserSettings(userId, settings = {}) {
    if (!Number.isInteger(userId)) {
        throw new Error(`[updateUserSettings] userId must be an integer, got ${userId}`);
    }

    let checked = validateSettings(settings);
    if (!Object.keys(checked.update).length) return { applied: checked.applied, rejected: checked.rejected };

    const db = await getDB();

    // Only a request to switch routines ON needs to know whether they are
    // onboarded, so only that pays for the read.
    if (checked.update["preferences.triggersOptIn"] === true) {
        const user = await db.collection(USERS).findOne({ userId }, { projection: { onboardedAt: 1 } });
        if (!user) throw new Error(`[updateUserSettings] no user with userId ${userId}`);
        checked = holdRoutinesUntilOnboarded(checked, user);
    }

    const { applied, rejected, update } = checked;
    if (!Object.keys(update).length) return { applied, rejected };

    const result = await db.collection(USERS).updateOne(
        { userId },
        { $set: { ...update, updatedAt: new Date() } }
    );

    if (!result.matchedCount) {
        throw new Error(`[updateUserSettings] no user with userId ${userId}`);
    }
    return { applied, rejected };
}

export const EDITABLE_SETTINGS = EDITABLE;
