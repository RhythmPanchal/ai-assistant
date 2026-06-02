import { tools } from "./toolOperator.js";
import { gemini_ai, gemini_model } from "./geminiClient.js";
import { createRecord } from "../tools/mongo/createRecord.js";
import { CHAT_HISTORY, ConversationBuilder } from "../tools/mongo/schema/chatHistorySchema.js";
import { buildSystemInstruction } from "./instruction.js";
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js";
import { dispatchAction } from "../scheduler/actionDispatcher.js";
import { getOpenFlowsForUser } from "../scheduler/flows/activeFlowsRepo.js";
import goodNightFlow from "./flows/goodNightFlow.js";
import goodMorningFlow from "./flows/goodMorningFlow.js";

// flowType → overlay instruction. Listed explicitly per known flow so the
// agent never picks up an overlay we have not vetted. Add new flows here.
const FLOW_OVERLAYS = {
    [goodNightFlow.flowType]: goodNightFlow.instruction,
    [goodMorningFlow.flowType]: goodMorningFlow.instruction,
};

export async function runAgent(userId, userInstruction) {
    try {
        // 1. Fetch chat history from DB
        const chatHistory = await chatHistoryKnowledge(userId);

        // 2. Pull any active flow overlays for this user (goodNight, goodMorning, …).
        //    Lazy expiry inside getOpenFlowsForUser keeps stale flows from leaking.
        const openFlows = await getOpenFlowsForUser(userId);
        const overlays = openFlows
            .map(flow => FLOW_OVERLAYS[flow.flowType])
            .filter(Boolean);

        // TEMP DEBUG — revert with the temp logs commit
        console.log(
            `[runAgent] user=${userId} openFlows=${openFlows.map(f => f.flowType).join(",") || "(none)"} overlaysApplied=${overlays.length}`
        );

        // 3. Build dynamic system instruction (agent persona + live time + overlays)
        const systemInstruction = buildSystemInstruction(overlays);

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

            // Run independent tool calls in parallel. Order of the response
            // array is preserved so it still lines up with response.functionCalls
            // when we ship results back to Gemini.
            const toolResults = await Promise.all(
                response.functionCalls.map(async (functionCall) => {
                    const { name, args } = functionCall;
                    try {
                        const result = await dispatchAction(name, args);
                        return { name, result };
                    } catch (err) {
                        // Surface the error to the LLM as a tool result so it
                        // can self-correct instead of crashing the whole turn.
                        console.error(`[runAgent] tool "${name}" failed:`, err);
                        return { name, result: { error: err.message || String(err) } };
                    }
                })
            );

            const functionResponseParts = toolResults.map(({ name, result }) => {
                console.log("\nExecuted function response:", result);
                console.log("---------------------------------");
                conversation.addToolResult(name, result);
                return {
                    functionResponse: {
                        name,
                        response: { result },
                    },
                };
            });

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