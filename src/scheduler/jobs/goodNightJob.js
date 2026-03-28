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