import "dotenv/config";
import { runAgent } from "../agent/agent.js";

async function test() {
    const instruction = `
    create a collection named "geminiGenerated" and add a record about iphone 15 pro max. 
    add a record " Hello my name is rhythm from ahmedabad" in a collection named chatHistory.
    ` ; 

    const result = await runAgent(instruction);
    console.log(JSON.stringify(result, null, 2));
    console.log("test ended");
}

test();
