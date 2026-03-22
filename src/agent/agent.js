import { tools, toolFunction } from "./toolOperator.js";
import { gemini_ai, gemini_model } from "./geminiClient.js";
import { response } from "express";
import { createRecord } from "../tools/mongo/createRecord.js";
import { chatHistoryBuilder, CHAT_HISTORY } from "../tools/mongo/schema/chatHistorySchema.js";
import agentInstruction from "./instruction.js"
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js"
import pendingTasksKnowledge from "../knowledge/pendingTasksKnowledge.js";
import { dispatchAction } from "../scheduler/actionDispatcher.js";

// function buildUserContext(text) {
//     return [
//         {
//             role: "user",
//             parts: [
//                 {
//                     text,
//                 },
//             ],
//         },
//     ];
// }

async function buildContext(userId, userInstruction) {
    const todayChatHistory = await chatHistoryKnowledge(userId);
    const pendingTasks = await pendingTasksKnowledge(userId);
    return [
        {
            role: "user",
            parts: [
                {
                    text: `
=== USER'S QUERY ===
${userInstruction}

=== AGENT INSTRUCTION ===
${agentInstruction}

=== TODAY'S CHAT HISTORY ===
${todayChatHistory}

Use this information as context. Do not repeat it unless needed.
`
                }
            ]
        }
    ];
}


export async function runAgent(userId, userInstruction) {
    try { 
        let contents = await buildContext(userId, userInstruction);
    //    console.log(JSON.stringify(contents, null, 2));
        //save user message into chathistory collection in db. 
        await createRecord(
            CHAT_HISTORY,
            chatHistoryBuilder(userId, userInstruction, "user")
        );

        while (true) {
            const result = await gemini_ai.models.generateContent({
                model: gemini_model,
                contents,
                config: { tools },
            });

            console.log("---------------------------------");
            console.log("User Query:", contents);
            console.log("\nLLM response:");
            console.dir(result, { depth: null, colors: true });

            if (result.functionCalls && result.functionCalls.length > 0) {
                const functionCalls = result.functionCalls;
                const responseParts = [];
                for (const functionCall of functionCalls) {
                    const { name, args } = functionCall;

                    const toolResponse = await dispatchAction(name, args);

                    console.log("\nExecuted function response:", toolResponse);
                    console.log("---------------------------------");

                    // Add the response to our list
                    responseParts.push({
                        functionResponse: {
                            name: functionCall.name,
                            response: { result: toolResponse }
                        }
                    });
                }

                //sending the function response back to model,
                //so if needed it created another model. 

                contents.push({
                    role: "model",
                    parts: functionCalls.map(call => ({
                        functionCall: call
                    }))
                });

                contents.push({
                    role: "user",
                    parts: responseParts
                });

            } else {
                const LLMresponse = result.text;
                console.log("FINAL LLM RESPONSE : ", LLMresponse);
                //store the final response in db. 
                await createRecord(
                    CHAT_HISTORY,
                    chatHistoryBuilder(userId, LLMresponse, "assistant")
                );

                return LLMresponse;
            }
        }
    } catch (error) {
        console.error("❌ Error in runAgent:", error);
        throw error; // rethrow so caller can handle it if needed
    }
}
