import "dotenv/config";
import express from "express";

import { getDB } from "./tools/mongo/mongoClient.js";
import { startTelegramPolling } from "./tools/telegram/telegramPoller.js";
import { handleTelegramMessage } from "./tools/telegram/telegramHandler.js"
import initCron from "./scheduler/initCron.js";
import {
  handleOAuthStart,
  handleOAuthCallback
} from "./tools/oauth/routes.js";

const app = express();
app.use(express.json());

async function initService(){
  try {
    // DB must be ready before the cron tick fires or the first trigger
    // executor runs against an uninitialized client.
    await getDB();
    initCron();
    await startTelegramPolling(handleTelegramMessage);

  }catch (e){
    console.log("Bot chatting is down : ", e);
  }
}

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ message: 'Telegram LLM Bot is running!' });
});

// OAuth flow endpoints — the provider redirects the user's browser through
// these. /auth/callback must match the Authorized redirect URI registered
// in each provider's console (Google Cloud, Notion integration settings,
// etc.). /auth/start is our internal kickoff endpoint, not registered with
// any provider. Both paths are derived from PUBLIC_BASE_URL via
// tools/oauth/redirectUri.js so they stay in lock-step with the
// redirect_uri sent to providers. Dispatch by appName lives inside the
// handlers — same routes serve every connector.
app.get('/auth/start', handleOAuthStart);
app.get('/auth/callback', handleOAuthCallback);


app.listen(PORT, () => {
  initService();
  console.log(`Server running on port ${PORT}`);
});
