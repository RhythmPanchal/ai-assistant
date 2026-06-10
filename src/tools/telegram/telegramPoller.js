import { routeCallbackQuery } from "./callbackRouter.js";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Backoff when Telegram returns a non-ok payload so we don't hammer the
// API in a tight loop on errors like 401, 429, or 5xx.
const ERROR_BACKOFF_MS = 5000;

let lastUpdateId = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function startTelegramPolling(onMessage) {
  console.log("Starting Telegram long polling...");

  while (true) {
    try {

      // allowed_updates explicitly enables callback_query — without it the
      // Telegram default still delivers them, but being explicit avoids
      // future surprises if Telegram changes defaults.
      const res = await fetch(
        `${TELEGRAM_API}/getUpdates?timeout=30&offset=${lastUpdateId + 1}` +
        `&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`
      );

      const data = await res.json();
      if (!data.ok) {
        console.error("Telegram API error:", data);
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }

      for (const update of data.result) {
        lastUpdateId = update.update_id;

        if (update.message?.text) {
          await onMessage(update.message);
          continue;
        }

        // Inline-keyboard button clicks come back as callback_query updates,
        // routed by callback_data prefix to feature handlers.
        if (update.callback_query) {
          await routeCallbackQuery(update.callback_query);
          continue;
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
      await sleep(1000);
    }
  }
}



