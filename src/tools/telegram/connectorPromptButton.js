import { generateConnectorLink } from "../../connectors/oauth/connectorLink.js";
import { resolveAddress } from "../../identity/userManager.js";


const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;


export async function connectorButton(userId, appName, text) {
  if (!userId) {
    return { ok: false, error: `[connectorButton] missing userId : ${userId}` };
  }
  if (!appName) {
    return { ok: false, error: `[connectorButton] missing appName : ${appName}` };
  }
  if (!text) {
    return { ok: false, error: `[connectorButton] missing text : ${text}` };
  }

  // userId identifies the person (it keys the connection doc and rides in
  // callback_data); the address is where the button actually gets delivered.
  const address = await resolveAddress(userId);
  if (!address) {
    return { ok: false, error: `[connectorButton] no telegram identity for userId ${userId}` };
  }

  // URL the [Connect] button opens — provided by the OAuth connector layer.
  const connectorLink = await generateConnectorLink(appName, userId);

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "Connect", url: connectorLink },
        { text: "Do not ask again", callback_data: `dismiss:${appName}:${userId}` },
      ],
    ],
  };

  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: address,
      text,
      reply_markup,
    }),
  });

  return await response.json();
}
