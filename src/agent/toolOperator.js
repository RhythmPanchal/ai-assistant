import { createCollection } from "../tools/mongo/createCollection.js";
import { createRecord } from "../tools/mongo/createRecord.js";
import { updateRecords } from "../tools/mongo/updateRecord.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import { createTask } from "../tools/mongo/operation/createTask.js";
import { insertSchedule } from "../tools/mongo/operation/insertSchedule.js";
import { createMultiTimeReminder, createOneTimeReminder } from "../scheduler/createReminders.js";

export const tools = [
    {
        functionDeclarations: [
            {
                name: "fetchCollectionNameAndSchema",
                description: "Fetches all available collection names, their schemas, and descriptions from MongoDB. You MUST call this before any read or write operation to know the correct collection name and its schema.",
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
                description: "Insert a record into a MongoDB collection. You MUST call fetchCollectionNameAndSchema first to know the correct collection name and schema before using this tool.",
                parameters: {
                    type: "object",
                    properties: {
                        collectionName: { type: "string" },
                        data: {
                            type: "object",
                            description: "The object to insert. Field names and types must match the collection's schema as returned by fetchCollectionNameAndSchema."
                        },
                    },
                    required: ["collectionName", "data"],
                },
            },
            {
                name: "createTask",
                description: "Add a new task to the user's task calendar. Use this whenever the user wants to create, add, or schedule a task. Try to infer and fill ALL fields from the user's message and context — do not leave fields empty if you can reasonably determine their values.",
                parameters: {
                    type: "object",
                    properties: {
                        userId: {
                            type: "integer",
                            description: "Identifier of the user who owns this task.",
                        },
                        title: {
                            type: "string",
                            description: "Title or name of the task.",
                        },
                        requiredMinutes: {
                            type: "integer",
                            description: "Estimated time in minutes to complete the task. Infer from context if possible.",
                        },
                        importance: {
                            type: "string",
                            enum: ["Low", "Medium", "High"],
                            description: "Importance level of the task. Infer from the nature of the task if not explicitly stated.",
                        },
                        priorityScore: {
                            type: "integer",
                            description: "Priority score from 1 (highest) to 5 (lowest). Infer based on urgency and importance.",
                        },
                        category: {
                            type: "string",
                            description: "Category of the task e.g. Work, Personal, Health, Finance. Always try to assign a category.",
                        },
                        deadline: {
                            type: "string",
                            description: "Task deadline in Asia/Kolkata. Write as naive ISO local time with NO trailing 'Z' and NO timezone offset, e.g. '2026-06-10T18:00:00' for 6 PM IST. Infer from context like 'by tomorrow', 'this week', etc.",
                        },
                        recurring: {
                            type: "string",
                            enum: ["hourly", "daily", "weekly", "monthly", "annually"],
                            description: "Recurrence pattern for the task. Set if the task appears to be recurring.",
                        },
                    },
                    required: ["userId", "title"],
                },
            },
            {
                name: "insertSchedule",
                description: `Insert the user's confirmed daily schedule. Call this ONLY after the user has reviewed and approved the schedule. The function automatically sorts slots by startTime and derives the day name from the date. Will fail if a schedule already exists for that userId + date.`,
                parameters: {
                    type: "object",
                    properties: {
                        userId: {
                            type: "integer",
                            description: "Identifier of the user who owns this schedule.",
                        },
                        date: {
                            type: "string",
                            description: "Schedule day in Asia/Kolkata as 'YYYY-MM-DD' (date only, no time, no 'Z', no offset), e.g. '2026-05-01'.",
                        },
                        slots: {
                            type: "array",
                            description: "Array of slot objects with full details for the confirmed schedule.",
                            items: {
                                type: "object",
                                properties: {
                                    slotId: {
                                        type: "string",
                                        description: "Unique slot identifier, e.g. 'slot_1', 'slot_2'.",
                                    },
                                    startTime: {
                                        type: "string",
                                        description: "Start time in HH:mm (24h). e.g. '09:00'.",
                                    },
                                    endTime: {
                                        type: "string",
                                        description: "End time in HH:mm (24h). e.g. '10:30'.",
                                    },
                                    title: {
                                        type: "string",
                                        description: "Activity name.",
                                    },
                                    category: {
                                        type: "string",
                                        description: "Category: Work, Personal, Health, Finance, etc.",
                                    },
                                    taskRef: {
                                        type: "string",
                                        description: "_id from taskCalendar if linked, else null.",
                                    },
                                    priority: {
                                        type: "string",
                                        enum: ["Low", "Medium", "High"],
                                        description: "Priority level.",
                                    },
                                    status: {
                                        type: "string",
                                        enum: ["Planned", "InProgress", "Done", "Skipped", "Rescheduled"],
                                        description: "Slot status.",
                                    },
                                    notes: {
                                        type: "string",
                                        description: "Extra context.",
                                    },
                                },
                                required: ["slotId", "startTime", "endTime", "title"],
                            },
                        },
                        summary: {
                            type: "string",
                            description: "Brief overview of the day plan.",
                        },
                        motivationalNote: {
                            type: "string",
                            description: "Motivational message for the day.",
                        },
                    },
                    required: ["userId", "date", "slots"],
                },
            },
            {
                name: "updateRecords",
                description: `Update one or more records by _id. You MUST call fetchRecord first to get real _ids — NEVER fabricate an _id. Send a single-element array for one record, or multiple elements for batch updates.`,
                parameters: {
                    type: "object",
                    properties: {
                        records: {
                            type: "array",
                            description: "Array of update operations. Do NOT include _id, createdAt, or updatedAt inside data.",
                            items: {
                                type: "object",
                                properties: {
                                    collectionName: {
                                        type: "string",
                                        description: "Collection name from fetchCollectionNameAndSchema.",
                                    },
                                    id: {
                                        type: "string",
                                        description: "The exact _id (24-char hex) from a fetchRecord response. NEVER fabricate.",
                                    },
                                    data: {
                                        type: "object",
                                        description: "Fields to update. Only include changed fields.",
                                    },
                                },
                                required: ["collectionName", "id", "data"],
                            },
                        },
                    },
                    required: ["records"],
                },
            },
            {
                name: "fetchRecord",
                description: "Fetch records from the database. You MUST call fetchCollectionNameAndSchema first to know the correct collection name before using this tool. Always include userId in filters. For date ranges use $gte and $lt operators with ISO date strings like \"2026-03-01\".",
                parameters: {
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
                            type: "integer",
                            description: "Identifier of the user who owns this reminder.",
                        },
                        nextExecutionAt: {
                            type: "string",
                            description: "When the reminder should fire, in Asia/Kolkata. Write as naive ISO local time with NO trailing 'Z' and NO timezone offset, e.g. '2025-06-01T20:00:00' for 8 PM IST.",
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
                name: "completeFlow",
                description: "Close the user's currently-open scheduled-routine flow (e.g. 'goodNight', 'goodMorning'). Call this ONLY when the active flow's overlay instructions say its completion criteria are met. Do NOT call for normal ad-hoc chat — only when a routine flow is active and finishing.",
                parameters: {
                    type: "object",
                    properties: {
                        userId: {
                            type: "integer",
                            description: "Identifier of the user whose flow should be closed.",
                        },
                        flowType: {
                            type: "string",
                            enum: ["goodNight", "goodMorning"],
                            description: "Which flow to close.",
                        },
                        reason: {
                            type: "string",
                            enum: ["done", "skipped"],
                            description: "Why the flow is closing. 'done' = completion criteria met. 'skipped' = user explicitly opted out for tonight/today.",
                        },
                    },
                    required: ["userId", "flowType", "reason"],
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
                            type: "integer",
                            description: "Identifier of the user who owns this reminder.",
                        },
                        cron: {
                            type: "string",
                            description: "Cron expression describing the recurrence (5-field, Asia/Kolkata timezone). e.g. '0 20 * * *' for every day at 8pm.",
                        },
                        nextExecutionAt: {
                            type: "string",
                            description: "When the reminder should first fire, in Asia/Kolkata. Write as naive ISO local time with NO 'Z' and NO timezone offset, e.g. '2025-06-01T20:00:00' for 8 PM IST.",
                        },
                        message: {
                            type: "string",
                            description: "Any extra description needed to execute the reminder action, e.g. { message: 'Take your medicine' }",
                        },
                        expiryDate: {
                            type: "string",
                            description: "When the recurring reminder should stop, in Asia/Kolkata. Same format rule as nextExecutionAt — naive ISO local time, no 'Z', no offset. e.g. '2026-06-01T20:00:00'.",
                        }

                    },
                    required: ["title", "userId", "cron", "nextExecutionAt", "message", "expiryDate"],
                },
            },
            {
                name: "connectApp",
                description: "Sends a Connect button so the user can authorize a third-party app. Use whenever the user wants to connect, link, or re-enable an app (e.g. 'connect Google Calendar', 'I accidentally dismissed calendar, reconnect it'). Validates that the app is supported before sending.",
                parameters: {
                    type: "object",
                    properties: {
                        userId: {
                            type: "integer",
                            description: "Telegram chat ID of the user.",
                        },
                        appName: {
                            type: "string",
                            description: "App identifier to connect. Currently supported: gCalendar.",
                        },
                    },
                    required: ["userId", "appName"],
                },
            },
            {
                name: "disconnectApp",
                description: "Disconnects a third-party app for the user — disables the connection and removes all stored tokens. Use when the user explicitly asks to disconnect, unlink, or revoke access for an app.",
                parameters: {
                    type: "object",
                    properties: {
                        userId: {
                            type: "integer",
                            description: "Telegram chat ID of the user.",
                        },
                        appName: {
                            type: "string",
                            description: "App identifier to disconnect. Currently supported: gCalendar.",
                        },
                    },
                    required: ["userId", "appName"],
                },
            },
        ],
    },
];

/*
Services needed for what --> 
create taskCalendar ✅ (addTask tool)
fetch tasksCalendar ❌
update taskCalendar ❌
fetch any collection according to user requirments 

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