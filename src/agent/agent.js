import { tools } from "./toolOperator.js";
import { gemini_ai, gemini_model } from "./geminiClient.js";
import { createRecord } from "../tools/mongo/createRecord.js";
import { CHAT_HISTORY, ConversationBuilder } from "../tools/mongo/schema/chatHistorySchema.js";
import { buildSystemInstruction } from "./instruction.js";
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js";
import { dispatchAction } from "../scheduler/actionDispatcher.js";


export async function runAgent(userId, userInstruction) {
    try {
        // 1. Fetch chat history from DB
        const chatHistory = await chatHistoryKnowledge(userId);
        // 2. Build dynamic system instruction (agent persona + live time)
        const systemInstruction = buildSystemInstruction();

        // 3. Create SDK-managed chat with history & system instruction
        const chat = gemini_ai.chats.create({
            model: gemini_model,
            history: chatHistory,  // structured [{role, parts}] from DB
            config: {
                systemInstruction,
                tools,
            },
        });

        // 4. Start building conversation document
        const conversation = new ConversationBuilder(userId);
        conversation.addUserMessage(userInstruction);

        // 5. Send user's query via chat (clean separation)
        console.log("User Query:", userInstruction);
        let response = await chat.sendMessage({ message: userInstruction });

        // 6. Agentic tool-call loop
        while (response.functionCalls && response.functionCalls.length > 0) {
            console.log("---------------------------------");
            console.log("\nLLM response (function calls):");
            console.dir(response, { depth: null, colors: true });

            // Record assistant function calls
            conversation.addAssistantFunctionCalls(response.functionCalls);

            const functionResponseParts = [];

            for (const functionCall of response.functionCalls) {
                const { name, args } = functionCall;
                const toolResponse = await dispatchAction(name, args);

                console.log("\nExecuted function response:", toolResponse);
                console.log("---------------------------------");

                // Record each tool result
                conversation.addToolResult(name, toolResponse);

                functionResponseParts.push({
                    functionResponse: {
                        name: functionCall.name,
                        response: { result: toolResponse },
                    },
                });
            }

            // Send tool results back — chat object auto-tracks conversation turns
            response = await chat.sendMessage({ message: functionResponseParts });
        }

        // 7. Final text response
        const LLMresponse = response.text;
        console.log("FINAL LLM RESPONSE:", LLMresponse);

        // 8. Record final assistant reply & persist entire conversation
        conversation.addAssistantMessage(LLMresponse);
        await createRecord(CHAT_HISTORY, conversation.build());

        return LLMresponse;
    } catch (error) {
        console.error("❌ Error in runAgent:", error);
        throw error;
    }
}