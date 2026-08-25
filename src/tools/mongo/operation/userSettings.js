import { getDB } from "../mongoClient.js";
import { USERS } from "../schema/usersSchema.js";

/**
 * Typed settings on the users document — the half of a profile that CODE reads.
 *
 * Separate from rememberFacts on purpose. userFact is prose only the model
 * consumes and can be wrong without breaking anything; these fields drive
 * behaviour. timezone decides when routines fire, currency is the unit on every
 * amount in expenseRegister, morningHour and nightHour decide when the bot
 * speaks first. A wrong value here is silent and lasting, so each one is
 * validated rather than trusted.
 */

const EDITABLE = ["name", "timezone", "currency", "locale", "status", "morningHour", "nightHour"];

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
        case "morningHour":
        case "nightHour": {
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
export function validateSettings(settings = {}) {
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

        // morningHour and nightHour live under preferences; the rest are
        // top-level. initCron reads preferences.morningHour, so a top-level
        // write here would be stored and then never read.
        const path = field === "morningHour" || field === "nightHour"
            ? `preferences.${field}`
            : field;

        update[path] = check.value;
        applied[field] = check.value;
    }

    return { applied, rejected, update };
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

    const { applied, rejected, update } = validateSettings(settings);

    if (!Object.keys(update).length) return { applied, rejected };

    const db = await getDB();
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
