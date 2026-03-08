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