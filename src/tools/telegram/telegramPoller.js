const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let lastUpdateId = 0;

export async function startTelegramPolling(onMessage) {
  console.log("Starting Telegram long polling...");

  while (true) {
    try {
       
      const res = await fetch(
        `${TELEGRAM_API}/getUpdates?timeout=30&offset=${lastUpdateId + 1}`
      );

      const data = await res.json(); 
      if (!data.ok) {
        console.error("Telegram API error:", data);
        continue;
      }

      for (const update of data.result) {
        lastUpdateId = update.update_id;

        if (update.message?.text) {
           console.log("getting here :", update.message)
          await onMessage(update.message);
        }
      }
    } catch (err) {
      console.error("Polling error:", err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}



