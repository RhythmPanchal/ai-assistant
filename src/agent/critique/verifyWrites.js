import { ObjectId } from "mongodb";
import { getDB } from "../../tools/mongo/mongoClient.js";
import { DIET_REGISTER } from "../../tools/mongo/schema/dietRegisterSchema.js";
import { TASK_REGISTER } from "../../tools/mongo/schema/taskRegisterSchema.js";
import { TASK_CALENDAR } from "../../tools/mongo/schema/taskCalendarSchema.js";
import { USER_SCHEDULE } from "../../tools/mongo/schema/userScheduleSchema.js";
import { TRIGGER_JOB } from "../../tools/mongo/schema/triggerJobSchema.js";
import { localDayRange, localDateOf, IST_TIMEZONE } from "../../tools/mongo/dateUtils.js";

/**
 * Re-checks every write the agent made against the database itself.
 *
 * A tool result is the agent's own account of what happened, and the critic
 * reading it is still only comparing a claim with a claim. `{success: true}`
 * is not a row, and the failure that costs real data — the write that reported
 * success and is not there — is invisible from the transcript alone.
 *
 * So this asks the database. Every check here is CODE, never the model: an
 * _id either resolves or it does not, and a verdict that can be computed must
 * not be opinionated about. The model is told the answers and may not overrule
 * them.
 *
 * READ ONLY. It runs against the production database, where a day's real
 * conversations are, and it must never write there — every query below is a
 * find.
 */

export const CONFIRMED = "CONFIRMED";
export const MISSING = "MISSING";
export const MISMATCH = "MISMATCH";
export const UNVERIFIABLE = "UNVERIFIABLE";

const asObjectId = (id) => {
    if (id instanceof ObjectId) return id;
    if (typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id)) return ObjectId.createFromHexString(id);
    return null;
};

const parseMaybeJson = (value) => {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
};

const short = (id) => String(id).slice(-6);

/**
 * Pair each function call with the tool result it produced.
 *
 * chatHistory stores a turn as an assistant message carrying functionCalls,
 * then one `tool` message per result. Matching by name against the calls still
 * outstanding handles the parallel case — two calls to the same tool in one
 * step get the results in dispatch order, which is the order runAgent preserves.
 */
export function pairCallsWithResults(messages = []) {
    const pairs = [];
    let pending = [];

    for (const msg of messages) {
        if (msg.role === "assistant" && Array.isArray(msg.functionCalls) && msg.functionCalls.length) {
            pending = msg.functionCalls.map(c => ({ name: c.name, args: c.args || {} }));
            continue;
        }
        if (msg.role === "tool") {
            const i = pending.findIndex(c => c.name === msg.toolName);
            const call = i === -1 ? { name: msg.toolName, args: {} } : pending.splice(i, 1)[0];
            pairs.push({ tool: msg.toolName || call.name, args: call.args, result: msg.result });
        }
    }

    // A call with no result at all: the step died before the tool answered, or
    // the turn was cut short. Worth surfacing — the agent may have spoken as if
    // it had landed.
    for (const call of pending) pairs.push({ tool: call.name, args: call.args, result: undefined });

    return pairs;
}

const ok = (result) => {
    if (!result || typeof result !== "object") return false;
    if (Array.isArray(result)) return false;
    // success is absent on the append tools, which report by returning the day.
    return result.success !== false && !result.error;
};

/** Did this call claim to have written anything? */
const WRITE_TOOLS = new Set([
    "createRecord", "updateRecords", "deleteRecord", "createTask", "insertSchedule",
    "updateSchedule", "addMeal", "replaceMeal", "addPerformedTask",
    "createOneTimeReminder", "createMultiTimeReminder", "cancelReminder",
    "updateNotes", "updateUserSettings",
]);

export const isWriteTool = (name) => WRITE_TOOLS.has(name);

/** Where a tool's insertedId lives, when the collection is fixed by the tool. */
const INSERT_TARGETS = {
    createTask: TASK_CALENDAR,
    insertSchedule: USER_SCHEDULE,
    createOneTimeReminder: TRIGGER_JOB,
    createMultiTimeReminder: TRIGGER_JOB,
};

/**
 * Loose equality for one updated field.
 *
 * Deliberately forgiving. The point is to catch an update that did not take,
 * not to police representation: the model sends an ISO string where the row
 * holds a Date, and numbers arrive as strings. Anything this cannot compare
 * confidently returns null — undecided, never a mismatch, because a false
 * MISMATCH would be reported to the critic as proven fact.
 */
export function fieldMatches(stored, wanted) {
    if (stored === undefined) return false;
    if (stored === null || wanted === null) return stored === wanted;

    if (stored instanceof Date) {
        const w = wanted instanceof Date ? wanted : new Date(wanted);
        return Number.isNaN(w.getTime()) ? null : Math.abs(stored.getTime() - w.getTime()) < 1000;
    }
    if (typeof stored === "object" || typeof wanted === "object") return null;
    if (typeof stored === "number" || typeof wanted === "number") {
        const a = Number(stored), b = Number(wanted);
        return Number.isFinite(a) && Number.isFinite(b) ? a === b : null;
    }
    if (typeof stored === "boolean" || typeof wanted === "boolean") return stored === wanted;
    return String(stored).trim() === String(wanted).trim();
}

/** The day-register document a day-scoped append should have landed in. */
async function dayDoc(db, collection, userId, date) {
    const { start, end } = localDayRange(date);
    return db.collection(collection).findOne({ userId, date: { $gte: start, $lt: end } });
}

/**
 * Verify one call. Returns {status, detail}.
 *
 * `turnDate` is the personal day the turn happened on, used when a call did not
 * carry its own date — the same ceiling pickLogDate applies on the write side.
 */
async function verifyOne(db, { tool, args, result }, { userId, turnDate }) {
    if (result === undefined) {
        return { status: MISSING, detail: "the call never returned — no tool result was recorded for it" };
    }
    if (!ok(result)) {
        // A refused write is not a defect. It becomes one only if the reply
        // claimed it worked, and that comparison is the critic's job.
        return { status: CONFIRMED, detail: `the call reported failure, so nothing should have been written (${result?.error ?? "error"})` };
    }

    const date = args?.date ? localDateOf(new Date(args.date), IST_TIMEZONE) : turnDate;

    switch (tool) {
        case "createRecord": {
            const collection = args?.collectionName;
            const id = asObjectId(result.insertedId);
            if (!collection || !id) return { status: UNVERIFIABLE, detail: "no collection name or insertedId to check" };
            const doc = await db.collection(collection).findOne({ _id: id });
            return doc
                ? { status: CONFIRMED, detail: `${collection}/…${short(id)} is in the database` }
                : { status: MISSING, detail: `${collection}/…${short(id)} was reported inserted and is NOT in the database` };
        }

        case "createTask":
        case "insertSchedule":
        case "createOneTimeReminder":
        case "createMultiTimeReminder": {
            const collection = INSERT_TARGETS[tool];
            const id = asObjectId(result.insertedId);
            if (!id) return { status: UNVERIFIABLE, detail: "the result carried no insertedId" };
            const doc = await db.collection(collection).findOne({ _id: id });
            if (!doc) return { status: MISSING, detail: `${collection}/…${short(id)} was reported inserted and is NOT in the database` };
            const note = result.duplicate ? " (reported as an existing duplicate, not a new row)" : "";
            return { status: CONFIRMED, detail: `${collection}/…${short(id)} is in the database${note}` };
        }

        case "deleteRecord": {
            const collection = args?.collectionName;
            const id = asObjectId(args?.id);
            if (!collection || !id) return { status: UNVERIFIABLE, detail: "no collection name or id to check" };
            const doc = await db.collection(collection).findOne({ _id: id });
            return doc
                ? { status: MISMATCH, detail: `${collection}/…${short(id)} was reported deleted and is STILL in the database` }
                : { status: CONFIRMED, detail: `${collection}/…${short(id)} is gone from the database` };
        }

        case "cancelReminder": {
            const id = asObjectId(args?.id);
            if (!id) return { status: UNVERIFIABLE, detail: "no reminder id to check" };
            const job = await db.collection(TRIGGER_JOB).findOne({ _id: id });
            if (!job) return { status: MISSING, detail: `triggerJob/…${short(id)} was reported cancelled and does not exist` };
            return job.status === "cancelled"
                ? { status: CONFIRMED, detail: `triggerJob/…${short(id)} is cancelled` }
                : { status: MISMATCH, detail: `triggerJob/…${short(id)} was reported cancelled and its status is "${job.status}"` };
        }

        case "updateRecords": {
            const records = parseMaybeJson(args?.records);
            if (!Array.isArray(records) || !records.length) {
                return { status: UNVERIFIABLE, detail: "the call carried no record list to check" };
            }

            const problems = [];
            const seen = [];
            for (const rec of records) {
                const collection = rec?.collectionName;
                const id = asObjectId(rec?.id);
                if (!collection || !id) { problems.push("a record had no collection or id"); continue; }

                const doc = await db.collection(collection).findOne({ _id: id });
                if (!doc) { problems.push(`${collection}/…${short(id)} does not exist`); continue; }

                const wanted = parseMaybeJson(rec?.data) || {};
                const stale = [];
                for (const [key, value] of Object.entries(wanted)) {
                    // Only top-level scalars. A nested object is what fieldMatches
                    // returns null for, and guessing there would manufacture a
                    // MISMATCH the critic is told to trust.
                    const verdict = fieldMatches(doc[key], value);
                    if (verdict === false) stale.push(`${key} is ${JSON.stringify(doc[key] ?? null)}, the call set ${JSON.stringify(value)}`);
                }
                if (stale.length) problems.push(`${collection}/…${short(id)}: ${stale.join("; ")}`);
                else seen.push(`${collection}/…${short(id)}`);
            }

            return problems.length
                ? { status: MISMATCH, detail: problems.join(" | ") }
                : { status: CONFIRMED, detail: `${seen.join(", ") || "every record"} holds the updated values` };
        }

        case "addMeal":
        case "replaceMeal": {
            const mealType = args?.mealType;
            if (!mealType || !date) return { status: UNVERIFIABLE, detail: "no mealType or date to check" };
            const doc = await dayDoc(db, DIET_REGISTER, userId, date);
            if (!doc) return { status: MISSING, detail: `no dietRegister document exists for ${date}` };
            const meals = (doc.meals ?? []).filter(m => m?.mealType === mealType);
            const wantedEmpty = Array.isArray(args?.items) && args.items.length === 0;
            if (wantedEmpty) {
                return meals.length
                    ? { status: MISMATCH, detail: `${mealType} on ${date} was reported removed and is still there` }
                    : { status: CONFIRMED, detail: `${mealType} on ${date} is gone` };
            }
            return meals.length
                ? { status: CONFIRMED, detail: `dietRegister ${date} holds ${mealType} with ${meals[0].items?.length ?? 0} item(s)` }
                : { status: MISSING, detail: `dietRegister ${date} exists but holds NO ${mealType}` };
        }

        case "addPerformedTask": {
            const title = args?.title ?? args?.task?.title;
            if (!title || !date) return { status: UNVERIFIABLE, detail: "no task title or date to check" };
            const doc = await dayDoc(db, TASK_REGISTER, userId, date);
            if (!doc) return { status: MISSING, detail: `no taskRegister document exists for ${date}` };
            const want = String(title).trim().toLowerCase();
            const hit = (doc.performedTasks ?? []).some(t => String(t?.title ?? "").trim().toLowerCase() === want);
            return hit
                ? { status: CONFIRMED, detail: `taskRegister ${date} holds "${title}"` }
                : { status: MISSING, detail: `taskRegister ${date} exists but does NOT hold "${title}"` };
        }

        default:
            // updateNotes, updateUserSettings, updateSchedule: writes whose effect
            // is a field rewrite with no id to resolve. Saying so is honest; a
            // CONFIRMED here would be a guess dressed as a check.
            return { status: UNVERIFIABLE, detail: `no database check is implemented for ${tool}` };
    }
}

/**
 * Verify every write in a day's turns.
 *
 * @param {Array} turnDocs [{ id, doc, date }] — the rendered turn id, its
 *        chatHistory document, and the personal day it happened on.
 * @returns {Promise<{checks: object[], counts: object}>}
 */
export async function verifyWrites(turnDocs = [], { userId }) {
    const db = await getDB();
    const checks = [];

    for (const { id, doc, date } of turnDocs) {
        for (const pair of pairCallsWithResults(doc.messages)) {
            if (!isWriteTool(pair.tool)) continue;
            let verdict;
            try {
                verdict = await verifyOne(db, pair, { userId, turnDate: date });
            } catch (err) {
                // A check that throws is unverifiable, never a failure. A bad
                // collection name in the args must not be reported as lost data.
                verdict = { status: UNVERIFIABLE, detail: `the check itself failed: ${err.message}` };
            }
            checks.push({ turn: id, tool: pair.tool, ...verdict });
        }
    }

    const counts = checks.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
    return { checks, counts };
}

/** The block the critic reads. Pure. */
export function renderVerificationBlock(checks = []) {
    if (!checks.length) {
        return "No write was attempted on this day, so there is nothing to verify.";
    }

    const width = Math.max(...checks.map(c => c.tool.length));
    const rows = checks.map(c =>
        `${c.turn.padEnd(4)} ${c.tool.padEnd(width)}  ${c.status.padEnd(13)} ${c.detail}`
    );

    return [
        "Every write this day attempted, re-checked against the database just now.",
        "These verdicts are computed, not judged — treat them as fact and do not overrule them.",
        "  CONFIRMED     the row really is there, or really is gone",
        "  MISSING       the tool reported success and the row is NOT in the database",
        "  MISMATCH      the row exists but does not hold what the call set",
        "  UNVERIFIABLE  no handle to check by. NOT the same as fine.",
        "",
        ...rows,
    ].join("\n");
}

/**
 * The MISSING and MISMATCH checks, as findings.
 *
 * Code-proven, so they bypass the model entirely — the same rule as
 * planComparison, where every number is computed because a model that cannot
 * add up must not be the thing that adds up. A critic asked to notice these
 * might; this way it cannot fail to.
 */
export function findingsFromChecks(checks = []) {
    return checks
        .filter(c => c.status === MISSING || c.status === MISMATCH)
        .map(c => ({
            turn: c.turn,
            kind: "bug",
            severity: "high",
            summary: `${c.tool} reported success but the database disagrees.`,
            evidence: `${c.turn} ${c.tool} ${c.status} — ${c.detail}`,
            suggestion: "Find why the write did not land. The tool returned success, so the fault is in the write path or its arguments, not in the model's phrasing.",
            quoted: true,
            source: "db",
        }));
}
