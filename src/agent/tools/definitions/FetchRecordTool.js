import { BaseTool, ToolResult } from "../BaseTool.js";
import { fetchRecord } from "../../../tools/mongo/fetchRecords.js";

export class FetchRecordTool extends BaseTool {
    static name = "fetchRecord";
    static description = "Fetch records from the database. You MUST call fetchCollectionNameAndSchema first to know the correct collection name before using this tool. Always include userId in filters. For date ranges use $gte and $lt operators with ISO date strings like '2026-03-01'.";
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
                description: "Max number of records to return. Defaults to 50.",
                default: 50,
            },
        },
        required: ["collection", "filters"],
    };

    async execute({ collection, filters, sortBy, sortOrder, limit }) {
        const result = await fetchRecord(collection, filters, sortBy, sortOrder, limit);
        return new ToolResult(true, `Fetched ${result ? result.length : 0} records from ${collection}.`, result);
    }
}

