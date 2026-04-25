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
const message = `I have noted your tasks and added them to your task registry\\. Here are the details and their respective IDs for tracking:

*Tasks:*

\\- *Watch OAuth 1 & 2 tutorials*  
  ID: \`69d266892a7612ade8d379c6\`  
  Deadline: 2026\\-04\\-10  

\\- *Learn connection liveness job*  
  ID: \`69d266892a7612ade8d379c7\`  
  Deadline: 2026\\-04\\-08  

\\- *Iron clothes*  
  ID: \`69d266892a7612ade8d379c8\`  
  Deadline: 2026\\-04\\-06  

\\- *Read about SSH, SSH tunnels, and JDBC*  
  ID: \`69d266892a7612ade8d379c9\`  
  Deadline: 2026\\-04\\-12  

I have noted the urgency of your *Iron clothes* task \\(deadline: tomorrow\\)\\. Please ensure you prioritize that to keep your schedule running smoothly\\. How would you like to proceed with these for your weekly plan\\?`;
   sendMessage(chatId, message); 
}

_testSendMessage();
