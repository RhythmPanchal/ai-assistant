import { runAgent } from "../../agent/agent.js";
import { sendMessage, editMessage, createThinkingAnimation, answerCallbackQuery } from "./sendMessage.js";
import { dismissCallbackHandler } from "../../connectors/oauth/dismissCallbackHandler.js";


// Callback query format: "<code>:<appName>:<userId>"
// codes: ["dismiss"]
export async function handleCallbackQuery(callbackQuery) {
  const { id: callbackQueryId, data, message } = callbackQuery;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;

  if (!data) {
    await answerCallbackQuery(callbackQueryId, "Something went wrong!");
    return;
  }

  const [code, appName, userIdStr] = data.split(":");
  // callback_data values are always strings after split; userId is a Telegram
  // chat id (int) in the DB so we must parse it before any DB query.
  const userId = parseInt(userIdStr, 10);

  if (code === "dismiss") {
    try {
      await dismissCallbackHandler(appName, userId);
      await answerCallbackQuery(callbackQueryId, "Got it, won't ask again.");
      if (chatId && messageId) {
        await editMessage(
          chatId,
          messageId,
          `Understood! I won't connect *${appName}* for now. You can always connect later by asking me.`,
          { reply_markup: { inline_keyboard: [] } }
        );
      }
    } catch (err) {
      console.error("[handleCallbackQuery] dismiss failed:", err);
      await answerCallbackQuery(callbackQueryId, "Something went wrong.");
    }
    return;
  }

  console.warn(`[handleCallbackQuery] Unknown callback code: ${code}`);
  await answerCallbackQuery(callbackQueryId);
}

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