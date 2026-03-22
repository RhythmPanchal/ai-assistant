import { createCollection } from "../tools/mongo/createCollection.js";
import { createRecord } from "../tools/mongo/createRecord.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";

export const toolFunction = {
    fetchCollectionNameAndSchema,
    createCollection,
    createRecord
}
export const tools = [
    {
        functionDeclarations: [
            {
                name: "fetchCollectionNameAndSchema",
                description: "Fetches collection name and schema, and decription about that collection in mongodb",
                parameters: {
                    type: "object"
                },
            },
            {
                name: "createCollection",
                description: "Create a MongoDB collection if it does not exist",
                parameters: {
                    type: "object",
                    properties: {
                        collectionName: { type: "string" },
                    },
                    required: ["collectionName"],
                },
            },
            {
                name: "createRecord",
                description: "Insert a record into a MongoDB collection, it will create a collection if does not exist",
                parameters: {
                    type: "object",
                    properties: {
                        collectionName: { type: "string" },
                        data: {
                            type: "string",
                            // CRITICAL CHANGE: Be specific about the format
                            description: "A valid JSON string representing the object to insert. If inserting chat history, format it as an array of objects: {\"messages\": [{\"sender\": \"...\", \"text\": \"...\"}]}. Do NOT use raw newlines."
                        },
                    },
                    required: ["collectionName", "data"],
                },
            },
            {
                name: "fetchRecord",
                description: `Fetch records from the database. Use this to retrieve expense, task, or diet records for the user.Always include userId in filters.For date ranges use $gte and $lt operators with ISO date strings like "2026-03-01".`,
                parameters: {
                    type: "object",
                    properties: {
                        collection: {
                            type: "string",
                            enum: ["expenseRegister", "taskRegister", "dietRegister", "taskCalendar"],
                            description: "The collection to query",
                        },
                        filters: {
                            type: "object",
                            description: `MongoDB filter object. Supports operators: $eq, $gt, $gte, $lt, $lte, $in, $nin.Example: { "userId": 123, "date": { "$gte": "2026-03-01", "$lt": "2026-04-01" }, "category": "Food" }`,
                        },
                        sortBy: {
                            type: "string",
                            description: "Field to sort by. Defaults to 'date'",
                            default: "date",
                        },
                        sortOrder: {
                            type: "string",
                            enum: ["asc", "desc"],
                            description: "Sort direction. Defaults to 'desc' (newest first)",
                            default: "desc",
                        },
                        limit: {
                            type: "number",
                            description: "Max number of records to return. Defaults to 50.",
                            default: 50,
                        },
                    },
                    required: ["collection", "filters"],
                },
            },
            {
                name: "createOneTimeReminder",
                description: "Creates a one-time reminder for the user. It will trigger once at the specified time. Always confirm the exact date and time with the user before calling this.",
                parameters: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            description: "Human-readable title for the reminder. e.g. 'Take medicine at 8pm'",
                        },
                        userId: {
                            type: "int",
                            description: "Identifier of the user who owns this reminder.",
                        },
                        nextExecutionAt: {
                            type: "string",
                            description: "ISO 8601 datetime string for when the reminder should trigger. e.g. '2025-06-01T20:00:00'",
                        },
                        message: {
                            type: "string",
                            description: "Any extra description needed to execute the reminder action, e.g. { message: 'Take your medicine' }",
                        },
                    },
                    required: ["title", "userId", "nextExecutionAt", "message"],
                },
            },
            {
                name: "createMultiTimeReminder",
                description: "Creates a reminder which can be used for multiple times for the user. It will trigger recursively according to cron until expiry date. please give cron and expiry date according to user query",
                parameters: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            description: "Human-readable title for the reminder. e.g. 'Take medicine at 8pm'",
                        },
                        userId: {
                            type: "int",
                            description: "Identifier of the user who owns this reminder.",
                        },
                        nextExecutionAt: {
                            type: "string",
                            description: "ISO 8601 datetime string for when the reminder should trigger. e.g. '2025-06-01T20:00:00'",
                        },
                        message: {
                            type: "string",
                            description: "Any extra description needed to execute the reminder action, e.g. { message: 'Take your medicine' }",
                        },
                        expiryDate: {
                            type: "string",
                            description: "ISO 8601 datetime string for after which trigger will expire. e.g. '2025-06-01T20:00:00'",
                        }

                    },
                    required: ["title", "userId", "nextExecutionAt", "message", "expiryDate"],
                },
            }
        ],
    },
];

/*
Services needed for what --> 
create taskCalendar ❌
fetch tasksCalendar ❌
update taskCalendar ❌
fetch any collection according to user requirments 

abending Service as it is not scalable --> better to create another tool to find schema and collection name which trigger every time agent request is send. 

in case of Trigger only 

morning Trigger
    fetch taskCalendar
    create Gcalendar event 

night trigger 
    update notionDB 
    update record in taskCalendar 
    create record in taskRegister
    create record in dietRegister
    create record in budgetRegister
*/