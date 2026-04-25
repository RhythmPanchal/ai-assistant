import { sendMessage } from "../../tools/telegram/sendMessage";

export async function goodNightJob(){
    const userId = 1136575387; 
    const message = `
    Hey! 😊
Before we wrap up the day, give me a quick update:

• How was your day overall?
• What tasks did you complete?
• What did you eat today?
• How much did you spend and on what?

Just drop everything casually—I’ll take care of organizing it and keeping you on track 📊
    `

    const res = await sendMessage(userId, message); 
    return res; 
}

/*curent job in mongo
{
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
  "nextExecutionAt": { "$date": "2026-03-30T22:30:00.000Z" },
  "expiryDate": null,
  "failedAt": null,
  "createdAt": { "$date": "2026-03-30T00:00:00.000Z" },
  "updatedAt": { "$date": "2026-03-30T00:00:00.000Z" }
}
*/