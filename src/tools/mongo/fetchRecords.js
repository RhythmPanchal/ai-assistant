import { getDB } from "./mongoClient.js";
import { DIET_REGISTER } from "./schema/dietRegisterSchema.js";
import { EXPENSE_REGISTER } from "./schema/expenseRegisterSchema.js";
import { TASK_CALENDAR } from "./schema/taskCalendarSchema.js";
import { TASK_REGISTER } from "./schema/taskRegisterSchema.js";
import { TRIGGER_JOB } from "./schema/triggerJobSchema.js";
import { USER_SCHEDULE } from "./schema/userScheduleSchema.js";
import { toIST, IST_TIMEZONE } from "./dateUtils.js";
import fetchCollectionNameAndSchema from "./fetchCollectionSchema.js";
import { getUserContext } from "../../identity/userContext.js";

const WHITELISTED_COLLECTIONS = {
	expenseRegister: EXPENSE_REGISTER,
	taskRegister: TASK_REGISTER,
	dietRegister: DIET_REGISTER,
	taskCalendar : TASK_CALENDAR,
	// Read-only here. The agent could not answer "what reminders do I have" or
	// "what is my plan today" without these — on 2026-08-16 a direct question
	// about a stale recurring reminder failed with a whitelist error.
	triggerJob: TRIGGER_JOB,
	userSchedule: USER_SCHEDULE,
};

const VALID_OPERATORS = ["$eq", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"];

/**
 * Collections where a document belongs to a day. A query against one of these
 * with no date bound is almost always the model forgetting to scope, not a
 * genuine all-time request: on 2026-08-13 a single turn pulled 22 diet + 23
 * task + 26 expense documents (~40 KB) to check one day, and every byte was
 * re-sent as context on each of the six following steps.
 */
const DAY_SCOPED = new Set(["dietRegister", "taskRegister", "expenseRegister", "userSchedule"]);

// 7 days, because that is already the window taskLogKnowledge and
// dietLogKnowledge use — the same "recent context" the morning job inlines.
// It covers today, yesterday and "this week"; anything wider has to ask for a
// date range explicitly, which is the habit worth teaching.
const DEFAULT_WINDOW_DAYS = 7;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Sort the model almost always wants, so an omitted sortBy still returns the
// most useful rows rather than insertion order.
const DEFAULT_SORT = {
	dietRegister: { field: "date", order: "desc" },
	taskRegister: { field: "date", order: "desc" },
	expenseRegister: { field: "date", order: "desc" },
	userSchedule: { field: "date", order: "desc" },
	taskCalendar: { field: "priorityScore", order: "asc" },
	triggerJob: { field: "nextExecutionAt", order: "asc" },
};

// Only coerce strings that actually look like ISO 8601 dates.
// Date.parse() accepts almost any numeric string (e.g. "1136575387" → year 123),
// which silently turned userId strings into Date objects and broke queries.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function coerceMaybeDate(val) {
	if (typeof val !== "string" || !ISO_DATE_RE.test(val)) return val;
	// toIST treats bare/`Z`-suffixed strings as IST wall-clock — matches how
	// stored records are anchored, so range queries hit the right boundaries.
	const parsed = toIST(val);
	return parsed && !isNaN(parsed.getTime()) ? parsed : val;
}

export async function fetchRecord(collection, filters = {}, sortBy, sortOrder = "desc", limit = 50) {
	// 0. Scope to the caller. This is the ONLY thing standing between the model
	//    and everyone else's rows, so it happens before anything else and it
	//    overwrites rather than defaults.
	//
	//    Until now the entire defence was the sentence "Always include userId in
	//    filters" in this tool's description — a request addressed to the model,
	//    with nothing enforcing it. Omit that key and the query returned every
	//    user's rows; name someone else's id and it returned theirs.
	//
	//    Spread order matters: the context goes LAST so a model-supplied userId
	//    is discarded, not merged.
	const context = getUserContext();
	filters = context.isSystem ? filters : { ...filters, userId: context.userId };

	// 1. Whitelist check
	const collectionName = WHITELISTED_COLLECTIONS[collection];
	if (!collectionName) {
		throw new Error(`Collection "${collection}" is not whitelisted. Allowed: ${Object.keys(WHITELISTED_COLLECTIONS).join(", ")}`);
	}

	// 2. Reject filter fields the collection does not have.
	//
	// Mongo returns [] for a field that does not exist, so a malformed filter
	// looked identical to "nothing logged yet" — the model read that as fact
	// and inserted a duplicate. Ten queries in one week used keys like
	// `Ref_date`, `convertDate`, or `"date"` with the quotes inside the key.
	const schema = fetchCollectionNameAndSchema()[collection]?.schema;
	if (schema?.properties) {
		const allowed = new Set([...Object.keys(schema.properties), "_id"]);
		const unknown = Object.keys(filters).filter(f => !allowed.has(f.split(".")[0]));
		if (unknown.length) {
			throw new Error(
				`Unknown filter field(s) on ${collection}: ${unknown.map(u => `"${u}"`).join(", ")}. ` +
				`Valid fields: ${[...allowed].join(", ")}.`
			);
		}
	}

	// 3. Sanitize filters — only allow known operators
	const sanitizedFilters = {};
	for (const [field, condition] of Object.entries(filters)) {
		if (typeof condition === "object" && condition !== null) {
			const sanitizedCondition = {};
			for (const [op, val] of Object.entries(condition)) {
				if (!VALID_OPERATORS.includes(op)) {
					throw new Error(`Operator "${op}" is not allowed.`);
				}
				sanitizedCondition[op] = coerceMaybeDate(val);
			}
			sanitizedFilters[field] = sanitizedCondition;
		} else {
			// Direct equality value
			sanitizedFilters[field] = coerceMaybeDate(condition);
		}
	}

	// 3. Bound an unscoped query on a day-scoped collection.
	const applied = [];
	if (DAY_SCOPED.has(collection) && !("date" in sanitizedFilters)) {
		const since = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000);
		const sinceDay = since.toLocaleDateString("en-CA", { timeZone: IST_TIMEZONE });
		sanitizedFilters.date = { $gte: toIST(sinceDay) };
		applied.push(`last ${DEFAULT_WINDOW_DAYS} days (from ${sinceDay})`);
	}

	// 4. Bound the row count. A caller asking for more than MAX_LIMIT is
	// capped rather than refused — the query still answers, just not with the
	// whole collection.
	const requested = Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT;
	const effectiveLimit = Math.min(requested, MAX_LIMIT);
	if (effectiveLimit < requested) applied.push(`limit capped at ${MAX_LIMIT}`);

	// 5. Sort. Falls back to the collection's natural ordering rather than the
	// old behaviour of no sort at all, so a limit returns the most useful rows
	// instead of whichever happened to be stored first. The default field is
	// per-collection because 'date' does not exist on taskCalendar.
	const fallback = DEFAULT_SORT[collection];
	const sortField = sortBy || fallback?.field;
	const sortDir = (sortOrder || (sortBy ? "desc" : fallback?.order)) === "asc" ? 1 : -1;

	const db = await getDB();
	const col = db.collection(collectionName);
	let cursor = col.find(sanitizedFilters);
	if (sortField) cursor = cursor.sort({ [sortField]: sortDir });

	const records = await cursor.limit(effectiveLimit).toArray();

	// The bound has to be visible to the caller. A silently truncated result
	// reads as "that is everything", which is how a missed record became a
	// duplicate insert.
	return { records, applied, truncated: records.length === effectiveLimit };
}

function formatForLLM(records) {
	const cleanData = (Array.isArray(records) ? records : [records]).map(item => {
		const { _id, createdAt, ...cleanItem } = item;

		// Format any date fields
		for (const [key, val] of Object.entries(cleanItem)) {
			if (val instanceof Date) {
				cleanItem[key] = val.toISOString().split("T")[0];
			}
		}

		return cleanItem;
	});

	return JSON.stringify(cleanData);
}

