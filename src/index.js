import "dotenv/config";
import express from "express";

import { getDB, ensureIndexes } from "./tools/mongo/mongoClient.js";
import { ensureFactKeys } from "./tools/mongo/operation/userFacts.js";
import { startTelegramPolling } from "./tools/telegram/telegramPoller.js";
import { handleTelegramMessage, handleCallbackQuery } from "./tools/telegram/telegramHandler.js"
import initCron from "./scheduler/initCron.js";
import oauthRouter from "./oauthRestAPI.js";
import adminRouter from "./adminRestAPI.js";

const app = express();
app.use(express.json());

async function initService(){
  try {
    // DB must be ready before the cron tick fires or the first trigger
    // executor runs against an uninitialized client.
    await getDB();

    // Before cron, so the minute-by-minute triggerExecutor query is indexed
    // from the first tick. Never throws — a failed index build is reported
    // and the bot still starts.
    await ensureIndexes();

    // Materialise the reviewed key spine into factKey. After ensureIndexes so
    // the unique index on key exists before the seed upserts against it.
    await ensureFactKeys();

    initCron();
    await startTelegramPolling(handleTelegramMessage, handleCallbackQuery);

  }catch (e){
    console.log("Bot chatting is down : ", e);
  }
}

const PORT = process.env.PORT || 3000;
const BOOTED_AT = new Date().toISOString();

app.get('/', (req, res) => {
  // commit is what tells one deploy apart from the one before it. Render sets
  // RENDER_GIT_COMMIT on every build, so polling this is how you know a push has
  // actually gone live rather than guessing from the clock.
  res.json({
    message: 'Telegram LLM Bot is running!',
    commit: process.env.RENDER_GIT_COMMIT ?? null,
    startedAt: BOOTED_AT,
  });
});

app.use(oauthRouter);
app.use(adminRouter);

app.listen(PORT, () => {
  initService(); 
  console.log(`Server running on port ${PORT}`);
});
