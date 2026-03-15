import { runAgent } from "../../agent/agent.js";
import {sendMessage}  from "./sendMessage.js";

export async function handleTelegramMessage(message) {
  
  const chatId = message.chat.id;
  const text = message.text;

  const reply = await runAgent(chatId, text);  
  console.log(
    "RUN AGNET COMPLETED WITH THIS REPLY"
  )
  await sendMessage(chatId,reply);
}
