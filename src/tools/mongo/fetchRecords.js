import { getDB } from "./mongoClient.js";
import { DIET_REGISTER } from "./schema/dietRegisterSchema.js";
import { EXPENSE_REGISTER } from "./schema/expenseRegisterSchema.js";
import { TASK_CALENDAR } from "./schema/taskCalendarSchema.js";
import { TASK_REGISTER } from "./schema/taskRegisterSchema.js";

const WHITELISTED_COLLECTIONS = {
	expenseRegister: EXPENSE_REGISTER,
	taskRegister: TASK_REGISTER,
	dietRegister: DIET_REGISTER,
	taskCalendar : TASK_CALENDAR
};

const VALID_OPERATORS = ["$eq", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"];

// Only coerce strings that actually look like ISO 8601 dates.
// Date.parse() accepts almost any numeric string (e.g. "1136575387" → year 123),
// which silently turned userId strings into Date objects and broke queries.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function coerceMaybeDate(val) {
	if (typeof val !== "string" || !ISO_DATE_RE.test(val)) return val;
	const parsed = new Date(val);
	return isNaN(parsed.getTime()) ? val : parsed;
}

export async function fetchRecord(collection, filters = {}, sortBy = "date", sortOrder = "desc", limit = 50) {
	// 1. Whitelist check
	const collectionName = WHITELISTED_COLLECTIONS[collection];
	if (!collectionName) {
		throw new Error(`Collection "${collection}" is not whitelisted. Allowed: ${Object.keys(WHITELISTED_COLLECTIONS).join(", ")}`);
	}

	// 2. Sanitize filters — only allow known operators
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

	// 3. Build sort
	const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

	// 4. Query
	const db = await getDB();
	const col = db.collection(collectionName);
	const records = await col.find(sanitizedFilters).sort(sort).limit(limit).toArray();

	// 5. Format for LLM
	return records; 
	// return formatForLLM(records);
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

