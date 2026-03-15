import "dotenv/config";
import { runAgent } from "../agent/agent.js";
import { startTelegramPolling } from "../tools/telegram/telegramPoller.js";
import { handleTelegramMessage } from "../tools/telegram/telegramHandler.js";
import { sendMessage } from "../tools/telegram/sendMessage.js";


async function test() {
   await startTelegramPolling(handleTelegramMessage);
   console.log("Test ended");
}

async function _testSendMessage(){
   const chatId = 1136575387; 
   const message = "Hello this is test message!";
   sendMessage(chatId, message); 
}

_testSendMessage();
