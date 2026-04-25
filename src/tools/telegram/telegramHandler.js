import { runAgent } from "../../agent/agent.js";
import { sendMessage } from "./sendMessage.js";

export async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;

  try {
    const reply = await runAgent(chatId, text);
    console.log("RUN AGENT COMPLETED WITH THIS REPLY");
    await sendMessage(chatId, reply);
  } catch (error) {
    console.error("[handleTelegramMessage] error:", error);

    const errorReply = [
      "⚠️ *Something went wrong*",
      "",
      "Sorry, I ran into an unexpected error while processing your message\\.",
      "Please try again in a moment\\.",
      "",
      "If this keeps happening, please report it to the admin\\.",
      "",
      `🪲 \`${String(error.message || error).slice(0, 200)}\``,
    ].join("\n");

    await sendMessage(chatId, errorReply);
  }
}