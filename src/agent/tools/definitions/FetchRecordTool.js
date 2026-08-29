import { BaseTool, ToolResult } from "../BaseTool.js";
import { fetchRecord } from "../../../tools/mongo/fetchRecords.js";

export class FetchRecordTool extends BaseTool {
    static name = "fetchRecord";
    static description = "Fetch records from the database. You MUST call fetchCollectionNameAndSchema first to know the correct collection name before using this tool. Results are automatically limited to the current user, so never filter by user yourself. For date ranges use $gte and $lt operators with ISO date strings like '2026-03-01'. On dietRegister, taskRegister, expenseRegister and userSchedule a query with no 'date' filter is automatically limited to the last 7 days — pass an explicit date range to look further back. Filter field names are validated against the collection schema, so a typo is an error rather than an empty result.";
    static parameters = {
        type: "object",
        properties: {
            collection: {
                type: "string",
                description: "The collection to query. Call fetchCollectionNameAndSchema first to get valid collection names.",
            },
            filters: {
                type: "object",
                description: `MongoDB filter object. Supports operators: $eq, $gt, $gte, $lt, $lte, $in, $nin. Example: { "userId": 123, "date": { "$gte": "2026-03-01", "$lt": "2026-04-01" }, "category": "Food" }`,
            },
            sortBy: {
                type: "string",
                description: "Optional. Field to sort by. Must exist on the target collection (e.g. 'deadline' for taskCalendar, 'date' for expenseRegister/taskRegister/dietRegister). Omit to skip sorting.",
            },
            sortOrder: {
                type: "string",
                enum: ["asc", "desc"],
                description: "Sort direction. Only applied when sortBy is provided. Defaults to 'desc' (newest first).",
            },
            limit: {
                type: "number",
                description: "Max number of records to return. Defaults to 20, capped at 100.",
                default: 20,
            },
        },
        required: ["collection", "filters"],
    };

    async execute({ collection, filters, sortBy, sortOrder, limit }) {
        const { records, applied, truncated } = await fetchRecord(collection, filters, sortBy, sortOrder, limit);

        // Any bound the query applied is stated in the message. A truncated
        // result that reads as "that is everything" is how a missed record
        // became a duplicate insert.
        const notes = [...applied];
        if (truncated) notes.push("more records may exist — narrow the filter or raise limit");

        return new ToolResult(
            true,
            `Fetched ${records.length} records from ${collection}.` +
            (notes.length ? ` (${notes.join("; ")})` : ""),
            records
        );
    }
}

