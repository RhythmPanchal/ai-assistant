import "dotenv/config";
import { runAgent } from "../agent/agent.js";
import { startTelegramPolling } from "../tools/telegram/telegramPoller.js";
import { handleTelegramMessage } from "../tools/telegram/telegramHandler.js";


async function test() {
   await startTelegramPolling(handleTelegramMessage);
   console.log("Test ended");
}

test();
