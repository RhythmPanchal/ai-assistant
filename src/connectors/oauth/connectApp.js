import { PROVIDER_MAP } from "./init.js";
import { connectorButton } from "../../tools/telegram/connectorPromptButton.js";
import { getDB } from "../../tools/mongo/mongoClient.js";

const CONNECT_TEXTS = {
  gCalendar: "📅 Connect your Google Calendar to let Rasmalai sync your daily schedules automatically. Tap *Connect* to authorize, or *Do not ask again* to skip.",
  notion: "📝 Connect your Notion workspace to let Rasmalai read and write your Notion pages and databases. Tap *Connect* to authorize, or *Do not ask again* to skip.",
};

export async function connectApp(userId, appName) {
  if (!PROVIDER_MAP[appName]) {
    const supported = Object.keys(PROVIDER_MAP).join(", ");
    return { success: false, message: `"${appName}" is not a supported connector. Supported apps: ${supported}.` };
  }

  const text = CONNECT_TEXTS[appName] ?? `Connect your ${appName} account to Rasmalai. Tap *Connect* to authorize, or *Do not ask again* to skip.`;

  const result = await connectorButton(userId, appName, text);
  const telegramMessageId = result?.result?.message_id ?? null;

  // Store message ID so notifyUser can edit this message after OAuth
  // completes — removing the inline keyboard and confirming the status.
  if (telegramMessageId) {
    const db = await getDB();
    await db.collection("connection").updateOne(
      { userId, appName },
      { $set: { telegramMessageId, updatedAt: Date.now() } }
    );
  }

  return { success: true, message: `Connect button sent for ${appName}. Please tap the button above to authorize.` };
}
