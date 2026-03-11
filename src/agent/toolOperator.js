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
              type: "string",
              description: "Identifier of the user who owns this reminder.",
            },
            nextExecutionAt: {
              type: "string",
              description: "ISO 8601 datetime string for when the reminder should trigger. e.g. '2025-06-01T20:00:00'",
            },
            message: {
              type: "object",
              description: "Any extra description needed to execute the reminder action, e.g. { message: 'Take your medicine' }",
            },
          },
          required: ["title", "userId", "nextExecutionAt", "message"],
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