import { runAgent } from "../../agent/agent.js";
import { sendMessage, editMessage, createThinkingAnimation } from "./sendMessage.js";


export async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;

  // Send animated "Thinking..." placeholder + typing indicator
  const thinking = await createThinkingAnimation(chatId);

  try {
    const reply = await runAgent(chatId, text);
    console.log("RUN AGENT COMPLETED WITH THIS REPLY");

    // Stop animation BEFORE editing — prevents race condition
    thinking.stop();

    // Edit the placeholder with the actual response
    if (thinking.messageId) {
      await editMessage(chatId, thinking.messageId, reply);
    } else {
      await sendMessage(chatId, reply);
    }
  } catch (error) {
    console.error("[handleTelegramMessage] error:", error);

    // Stop animation BEFORE editing
    thinking.stop();

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

    if (thinking.messageId) {
      await editMessage(chatId, thinking.messageId, errorReply);
    } else {
      await sendMessage(chatId, errorReply);
    }
  }
}