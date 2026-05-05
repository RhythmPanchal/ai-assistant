import "dotenv/config";
import { createRecord } from "../tools/mongo/createRecord.js";
import { getDB } from "../tools/mongo/mongoClient.js"
import { TRIGGER_JOB } from "../tools/mongo/schema/triggerJobSchema.js";

async function addGoodMorningJob() {
    const GoodMorningJob = {
        "title": "Good Morning Routine",
        "userId": -1,
        "type": "recurring",
        "recurring": true,
        "cronPattern": "0 9 * * *",
        "timeZone": "Asia/Kolkata",
        "actionType": "goodMorningJob",
        "payload": {},
        "status": "active",
        "attempts": 0,
        "maxAttempts": 3,
        "lastExecutedAt": null,
        "nextExecutionAt": "2026-05-04T06:20:00.000Z",
        "expiryDate": null,
        "failedAt": null,
        "createdAt": "2026-05-04T06:17:00.000Z",
    }


    const db = getDB();
    const res = await createRecord(TRIGGER_JOB, GoodMorningJob);

    console.log(res);
}

async function addGoodNightJob() {
    const GoodNightJob = {
        "title": "Good Night Routine",
        "userId": -1,
        "type": "recurring",
        "recurring": true,
        "cronPattern": "0 23 * * *",
        "timeZone": "Asia/Kolkata",
        "actionType": "goodNightJob",
        "payload": {},
        "status": "active",
        "attempts": 0,
        "maxAttempts": 3,
        "lastExecutedAt": null,
        "nextExecutionAt": "2026-05-04T06:17:00.000Z",
        "expiryDate": null,
        "failedAt": null,
        "createdAt": "2026-05-04T06:17:00.000Z",
    }


    const db = getDB();
    const res = await createRecord(TRIGGER_JOB, GoodNightJob);

    console.log(res);
}


addGoodNightJob(); 