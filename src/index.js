import "dotenv/config";
import express from "express";

import { getDB } from "./tools/mongo/mongoClient.js";
import { startTelegramPolling } from "./tools/telegram/telegramPoller.js";
import { handleTelegramMessage } from "./tools/telegram/telegramHandler.js"
import initCron from "./scheduler/initCron.js";

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


app.listen(PORT, () => {
  initService(); 
  console.log(`Server running on port ${PORT}`);
});
