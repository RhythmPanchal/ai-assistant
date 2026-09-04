import { runAgent } from "../../agent/agent.js";
import { resolveUserByChannel } from "../../identity/userManager.js";
import { runWithUserContext } from "../../identity/userContext.js";
import { NO_REPLY } from "../../agent/instruction.js";
import { sendMessage, editMessage, startTyping, answerCallbackQuery } from "./sendMessage.js";
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

  const [code, appName] = data.split(":");

  // Identity comes from `from`, NOT from the userId embedded in callback_data.
  // That trailing field round-trips through the Telegram client, so trusting it
  // is the same mistake as trusting a userId the model supplied — the value is
  // whatever came back, not whatever we sent. from.id is the authenticated
  // sender, and it is what every other entry point resolves on.
  const externalId = callbackQuery.from?.id;
  if (!externalId) {
    console.warn("[handleCallbackQuery] no from.id — cannot attribute this to anyone");
    await answerCallbackQuery(callbackQueryId, "Something went wrong.");
    return;
  }

  const { userId } = await resolveUserByChannel("telegram", externalId, { address: chatId });

  if (code === "dismiss") {
    try {
      await runWithUserContext(
        { userId, channel: "telegram", address: chatId },
        () => dismissCallbackHandler(appName, userId)
      );
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
  // chatId is the ADDRESS replies go to. It is NOT the identity: in a group
  // it is the group's id, shared by everyone in it.
  const chatId = message.chat.id;
  const text = message.text;

  // Channel posts and service messages carry no sender. Nothing here can be
  // attributed to a person, so there is nobody to answer as.
  const externalId = message.from?.id;
  if (!externalId) {
    console.warn("[handleTelegramMessage] update has no message.from — ignoring");
    return;
  }

  // Telegram's native "typing…" badge, nothing in the transcript. See
  // startTyping for why the "Processing..." placeholder was removed.
  const typing = startTyping(chatId);

  try {
    // from.id, never chat.id — see resolveUserByChannel.
    const { userId, isNew } = await resolveUserByChannel("telegram", externalId, {
      address: chatId,
      displayName: message.from?.first_name ?? null,
    });

    // TODO(onboarding): open the onboarding flow here once it exists. Until
    // then a new user simply gets a working bot with an empty profile.
    if (isNew) console.log(`[handleTelegramMessage] first contact — allocated userId ${userId}`);

    // The trust boundary. This is the only place in a user turn where identity
    // is established from something authenticated, so it is the only place the
    // context may be bound. Everything runAgent touches — the loop, every tool,
    // every query underneath — reads userId from here instead of being told it.
    // TODO(metrics): surface `metrics` to the user behind a debug toggle.
    const { text: reply } = await runWithUserContext(
      { userId, channel: "telegram", address: chatId },
      () => runAgent(userId, text)
    );
    console.log("RUN AGENT COMPLETED WITH THIS REPLY");

    // The agent decided nothing needs saying. It is already recorded in
    // chatHistory; here it means going quiet rather than sending the sentinel
    // to the user as text. With no placeholder there is nothing to clean up.
    if (reply?.trim() === NO_REPLY) {
      console.log("[handleTelegramMessage] NO_REPLY — closing silently");
      return;
    }

    await sendMessage(chatId, reply);
  } catch (error) {
    console.error("[handleTelegramMessage] error:", error);

    // Plain sentences, no MarkdownV2 escapes. The renderer strips stray
    // backslashes, but writing them here only ever risked them reaching the
    // user as literal characters.
    const errorReply = [
      "*Something went wrong.*",
      "",
      "I hit an unexpected error handling that. Try again in a moment — if it keeps happening, it is worth reporting.",
      "",
      `\`${String(error.message || error).slice(0, 200)}\``,
    ].join("\n");

    await sendMessage(chatId, errorReply);
  } finally {
    // finally, not per-branch: an early return or a throw from sendMessage would
    // otherwise leave the 4s interval running for the life of the process.
    typing.stop();
  }
}