import { getDB } from "../../tools/mongo/mongoClient.js";
import { resolveProvider } from "./init.js";
import { sendMessage, editMessage } from "../../tools/telegram/sendMessage.js";
import { resolveAddress } from "../../agent/userManager.js";

const BOT_URL = "https://web.telegram.org/k/#@TskMgrRhythmBot";

function htmlPage(success, appName) {
  const icon  = success ? "🎉" : "❌";
  const title = success ? "Connected!" : "Connection Failed";
  const body  = success
    ? `<strong>${appName}</strong> has been connected successfully.<br>Your schedules will now sync automatically.`
    : `Could not connect <strong>${appName}</strong>.<br>Please go back to the bot and try again.`;
  const color = success ? "#22c55e" : "#ef4444";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f0f0f;
      color: #f1f1f1;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 16px;
      padding: 40px 48px;
      text-align: center;
      max-width: 400px;
      width: 90%;
    }
    .icon { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 24px; font-weight: 700; color: ${color}; margin-bottom: 12px; }
    p  { font-size: 15px; color: #a1a1aa; line-height: 1.6; margin-bottom: 28px; }
    a {
      display: inline-block;
      background: #2563eb;
      color: #fff;
      text-decoration: none;
      padding: 12px 28px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
    }
    a:hover { background: #1d4ed8; }
    .redirect { margin-top: 16px; font-size: 12px; color: #52525b; }
  </style>
  <meta http-equiv="refresh" content="4;url=${BOT_URL}" />
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
    <a href="${BOT_URL}">Open Rasmalai</a>
    <p class="redirect">Redirecting automatically in 4 seconds…</p>
  </div>
</body>
</html>`;
}

export async function callbackOauth(code, state, res) {
  const sendHtml = (status, success, appName) =>
    res.status(status).send(htmlPage(success, appName ?? "the app"));

  if (!code || !state) {
    return sendHtml(400, false);
  }

  try {
    const db = await getDB();
    const connection = await db.collection("connection").findOne({ stateToken: state });
    if (!connection) {
      return sendHtml(400, false);
    }

    const provider = await resolveProvider(connection.appName);

    const tokenRequest = provider.buildTokenRequest(code, process.env.OAUTH_CALLBACK);
    const tokenResponse = await fetch(tokenRequest.url, {
      method: tokenRequest.method,
      headers: tokenRequest.headers,
      body: tokenRequest.body,
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      console.error("[callbackOauth] Token exchange failed:", errBody);
      notifyUser(connection, false).catch(() => {});
      return sendHtml(502, false, connection.appName);
    }

    const tokenData = await tokenResponse.json();

    const now = Date.now();
    // expires_in from providers is in seconds; store as epoch ms.
    const expiresAt = tokenData.expires_in ? now + tokenData.expires_in * 1000 : null;

    await db.collection("connection").updateOne(
      { stateToken: state },
      {
        $set: {
          access_token: tokenData.access_token,
          ...(tokenData.refresh_token && { refresh_token: tokenData.refresh_token }),
          ...(tokenData.scope && { scope: tokenData.scope }),
          expiresAt,
          status: "ACTIVE",
          updatedAt: now,
        },
      }
    );

    notifyUser(connection, true).catch(() => {});

    provider.onConnectionEstablished(connection.userId).catch(err =>
      console.error("[callbackOauth] onConnectionEstablished failed:", err)
    );
    return sendHtml(200, true, connection.appName);
  } catch (err) {
    console.error("[callbackOauth] Failed to handle OAuth callback:", err);
    return sendHtml(500, false);
  }
}

async function notifyUser(connection, success) {
  // connection.userId is an internal identity, not a chat id.
  const chatId = await resolveAddress(connection.userId);
  if (!chatId) {
    console.error(`[notifyUser] no telegram identity for userId ${connection.userId}`);
    return;
  }
  const messageId = connection.telegramMessageId ?? null;
  const appName = connection.appName;

  const text = success
    ? `🎉 *${appName} connected successfully!`
    : `❌ Failed to connect *${appName}*. Please try again or contact support.`;

  const clearKeyboard = { reply_markup: { inline_keyboard: [] } };

  if (messageId) {
    // Edit the original button message — removes the inline keyboard and confirms status.
    await editMessage(chatId, messageId, text, clearKeyboard);
  } else {
    // No stored message ID (edge case) — fall back to a new message.
    await sendMessage(chatId, text);
  }
}
