import "dotenv/config";
import { runAgent } from "../agent/agent.js";
import { dispatchAction } from "../scheduler/actionDispatcher.js";

async function test() {
    const instruction = `
    create a collection named "geminiGenerated" and add a record about iphone 15 pro max. 
    add a record " Hello my name is rhythm from ahmedabad" in a collection named chatHistory.
    ` ; 

    const result = await runAgent({userId : 123, userInstruction: instruction});
    console.log(JSON.stringify(result, null, 2));
    console.log("test ended");
}

async function _testDispatchActionFromAgent(){
    const functioncall = {
    "actionType" : "sendMessage",
    "payload" : {
      "chatId" : 1136575387,
      "text" : "Hello this is test message"
    }
  }

  const res = await dispatchAction(functioncall.actionType, functioncall.payload); 
  console.log(res); 
}

_testDispatchActionFromAgent();
