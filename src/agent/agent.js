import toolRegistry from "./tools/definitions/index.js";
import { ProviderManager } from "./llm/createProvider.js";
import { createRecord } from "../tools/mongo/createRecord.js";
import { CHAT_HISTORY, ConversationBuilder } from "../tools/mongo/schema/chatHistorySchema.js";
import { buildSystemInstruction } from "./instruction.js";
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js";
import { getOpenFlowsForUser } from "../scheduler/flows/activeFlowsRepo.js";
import goodNightFlow from "./flows/goodNightFlow.js";
import goodMorningFlow from "./flows/goodMorningFlow.js";
import { agentConfig } from "../config/agent.config.js";

function withTimeout(promise, ms, toolName) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Tool "${toolName}" timed out`)), ms)
        )
    ]);
}


const FLOW_OVERLAYS = {
    [goodNightFlow.flowType]: goodNightFlow.instruction,
    [goodMorningFlow.flowType]: goodMorningFlow.instruction,
};

export async function runAgent(userId, userInstruction, userProfile) {
    try {
        const chatHistory = await chatHistoryKnowledge(userId);
        const openFlows = await getOpenFlowsForUser(userId);
        const overlays = openFlows
            .map(flow => FLOW_OVERLAYS[flow.flowType])
            .filter(Boolean);

        // Pass user profile to the prompt builder
        const systemInstruction = buildSystemInstruction(userProfile, overlays);

        const conversation = new ConversationBuilder(userId);
        conversation.addUserMessage(userInstruction);

        // Initialize messages array using the format expected by the ProviderManager
        const messages = [
            { role: "system", content: systemInstruction }
        ];

        // chatHistory is already returned in generic format from chatHistoryKnowledge
        for (const msg of chatHistory) {
            messages.push(msg);
        }

        messages.push({ role: "user", content: userInstruction });

        console.log("User Query:", userInstruction);

        const providerManager = new ProviderManager(userProfile?.apiKeys || {});
        const toolsDeclarations = toolRegistry.getToolDeclarations();

        let stepCount = 0;
        const maxSteps = agentConfig.llm.maxSteps;
        let LLMresponse = "";

        while (stepCount < maxSteps) {
            stepCount++;
            console.log(`--- ReAct Step ${stepCount} ---`);

            // chatWithFallback tries the primary provider and automatically falls back to others on error.
            const response = await providerManager.chatWithFallback(messages, toolsDeclarations);

            if (response.hasToolCalls()) {
                console.log("\nLLM response (function calls):");
                response.toolCalls.forEach(tc => console.log(`- ${tc.name}(${JSON.stringify(tc.args)})`));

                const formattedToolCalls = response.toolCalls.map(tc => ({
                    id: tc.id,
                    name: tc.name,
                    args: tc.args
                }));
                
                conversation.addAssistantFunctionCalls(formattedToolCalls);
                
                // Add the assistant's tool call message to the history
                messages.push({
                    role: "assistant",
                    content: response.text || null,
                    toolCalls: response.toolCalls
                });

                // Execute all tools in parallel
                const toolResults = await Promise.all(
                    response.toolCalls.map(async (tc) => {
                        try {
                            const timeoutMs = agentConfig.llm.toolTimeoutMs || 15000;
                            const result = await withTimeout(toolRegistry.execute(tc.name, tc.args), timeoutMs, tc.name);
                            return { id: tc.id, name: tc.name, result: result.data || result.message || result };
                        } catch (err) {
                            console.error(`[runAgent] tool "${tc.name}" failed:`, err);
                            return { id: tc.id, name: tc.name, result: { error: err.message || String(err) } };
                        }
                    })
                );

                // Add tool results to conversation and message history
                toolResults.forEach(tr => {
                    console.log(`\nTool result [${tr.name}]:`, tr.result);
                    conversation.addToolResult(tr.name, tr.result);
                    messages.push({
                        role: "tool_result",
                        toolCallId: tr.id,
                        toolName: tr.name,
                        content: tr.result
                    });
                });
            } else {
                // Final text response
                LLMresponse = response.text || "";
                console.log("FINAL LLM RESPONSE:", LLMresponse);
                
                conversation.addAssistantMessage(LLMresponse);
                await createRecord(CHAT_HISTORY, conversation.build());
                break;
            }
        }

        if (stepCount >= maxSteps) {
            console.warn("Agent reached max steps. Terminating loop.");
            LLMresponse = "I had to stop because the task took too many steps. Here is what I figured out so far: " + LLMresponse;
            conversation.addAssistantMessage(LLMresponse);
            await createRecord(CHAT_HISTORY, conversation.build());
        }

        return LLMresponse;
    } catch (error) {
        console.error("❌ Error in runAgent:", error);
        throw error;
    }
}