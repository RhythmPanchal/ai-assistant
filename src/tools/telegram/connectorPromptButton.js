import { generateConnectorLink } from "../../connectors/oauth/connectorLink.js";
import { resolveAddress } from "../../identity/userManager.js";
import { sendMessage } from "./sendMessage.js";


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

  // Through sendMessage rather than its own fetch. The connect copy says
  // 'Tap *Connect* to authorize', and this used to post it with no parse_mode —
  // so the asterisks reached the user literally, on the one message whose whole
  // job is to be tapped. Going through the shared sender also picks up escaping
  // and the plain-text fallback, and keeps this the only place that builds the
  // keyboard rather than the only place that duplicates the transport.
  return sendMessage(address, text, { reply_markup });
}
