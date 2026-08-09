import toolRegistry from "./tools/definitions/index.js";
import { ProviderManager, resolveMaxSteps, resolveTaskChain } from "./llm/createProvider.js";
import { startTurn } from "./llm/usageMeter.js";
import { agentConfig } from "../config/agent.config.js";
import { getUserProfile } from "./userManager.js";
import { createRecord } from "../tools/mongo/createRecord.js";
import { CHAT_HISTORY, ConversationBuilder } from "../tools/mongo/schema/chatHistorySchema.js";
import { buildSystemInstruction } from "./instruction.js";
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js";
import { getOpenFlowsForUser } from "../scheduler/flows/activeFlowsRepo.js";
import goodNightFlow from "./flows/goodNightFlow.js";
import goodMorningFlow from "./flows/goodMorningFlow.js";

// flowType → overlay instruction. Listed explicitly per known flow so the
// agent never picks up an overlay we have not vetted. Add new flows here.
const FLOW_OVERLAYS = {
    [goodNightFlow.flowType]: goodNightFlow.instruction,
    [goodMorningFlow.flowType]: goodMorningFlow.instruction,
};

/**
 * Per-flow state the overlay needs but cannot infer from the transcript.
 * Without this the scratchpad is write-only and the two-strike rule in the
 * goodMorning overlay can never fire.
 */
export function flowStateBlock(flow) {
    const sp = flow.scratchpad || {};
    return [
        "-------------------------------------",
        `📌 FLOW STATE (${flow.flowType})`,
        `- unrelatedReplies so far: ${sp.unrelatedReplies ?? 0}`,
        `- opened: ${flow.startedAt ? new Date(flow.startedAt).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" }) : "unknown"}`,
        "-------------------------------------",
    ].join("\n");
}

// openFlow only supersedes flows of the SAME type, so two types can be open at
// once and the mapping needs an explicit precedence. goodNight wins: it is the
// schema-critical logging flow, and an unengaged morning flow stays open until
// the evening cutoff, so it can still be open when goodNight fires.
const FLOW_TASK_PRECEDENCE = ["goodNight", "goodMorning"];

// Jobs that open NO flow identify themselves by source instead.
const SOURCE_TASKS = { summarizeJob: "summarize", slackIngest: "ingest" };

/**
 * Which model chain this turn should use.
 *
 * Flow-derived by default: a routine job only ever runs with its own flow
 * already open, and that flow outlives the job to cover the user's follow-up
 * turns — so the flow, not the caller, is the source of truth.
 */
export function resolveTask({ source, openFlows = [], override = null }) {
    if (override) return override;
    for (const flowType of FLOW_TASK_PRECEDENCE) {
        if (openFlows.some(f => f.flowType === flowType)) return flowType;
    }
    return SOURCE_TASKS[source] || "conversation";
}

// A tool that never returns would hang the turn forever, holding the Telegram
// "thinking" animation open with no way out.
function withTimeout(promise, ms, toolName) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${ms}ms`)), ms)
        ),
    ]);
}

export async function runAgent(userId, userInstruction, source = "telegram", taskOverride = null) {
    const meter = startTurn(userId, source);

    try {
        const chatHistory = await chatHistoryKnowledge(userId);

        // Active flow overlays. Lazy expiry inside getOpenFlowsForUser. keeps stale flows from leaking.
        const openFlows = await getOpenFlowsForUser(userId);
        const overlays = openFlows
            .filter(f => FLOW_OVERLAYS[f.flowType])
            .map(f => `${FLOW_OVERLAYS[f.flowType]}\n\n${flowStateBlock(f)}`);

        // 3. Persona + live IST time + overlays. Rebuilt every turn.
        const systemInstruction = buildSystemInstruction(overlays);

        // 4. The user's own API keys, if they supplied any. Absent keys fall
        //    through to the internal env keys inside each provider factory.
        let userProfile = null;
        try {
            userProfile = await getUserProfile(userId);
        } catch (e) {
            console.warn("[runAgent] user profile lookup failed, using internal keys:", e.message);
        }

        const messages = [
            { role: "system", content: systemInstruction },
            ...chatHistory,
            { role: "user", content: userInstruction },
        ];

        const conversation = new ConversationBuilder(userId);
        conversation.addUserMessage(userInstruction);

        const task = resolveTask({ source, openFlows, override: taskOverride });
        const maxSteps = resolveMaxSteps(task);

        const providerManager = new ProviderManager(userProfile?.apiKeys || {}, task);
        const toolDeclarations = toolRegistry.getToolDeclarations();
        const toolTimeoutMs = agentConfig.llm.toolTimeoutMs;

        const chain = resolveTaskChain(task).map(e => `${e.provider}:${e.model}`).join(" -> ");
        console.log(`[runAgent] task=${task} maxSteps=${maxSteps}\n  chain: ${chain}`);
        console.log("User Query:", userInstruction);

        let LLMresponse = "";
        let steps = 0;

        // Each iteration is at least one billable request, so the loop is bounded.
        while (steps < maxSteps) {
            steps++;

            let response;
            try {
                response = await providerManager.chatWithFallback(messages, toolDeclarations, {
                    // Per MODEL, not per provider — each has its own daily
                    // bucket, so that is the granularity worth tracking.
                    onAttempt: (provider, model) => meter.recordCall(`${provider}:${model}`),
                });
            } catch (err) {
                meter.recordError(err);
                throw err;
            }

            if (!response.hasToolCalls()) {
                LLMresponse = response.text || "";
                break;
            }

            console.log(`--- step ${steps} via ${response.provider} ---`);
            response.toolCalls.forEach(tc => console.log(`  ${tc.name}(${JSON.stringify(tc.args)})`));

            conversation.addAssistantFunctionCalls(response.toolCalls);
            messages.push({
                role: "assistant",
                content: response.text || null,
                toolCalls: response.toolCalls,
            });

            // Independent calls run in parallel. toolRegistry.execute already
            // converts a throw into a failed ToolResult, so only the timeout
            // needs catching here.
            const results = await Promise.all(
                response.toolCalls.map(async (tc) => {
                    try {
                        const result = await withTimeout(
                            toolRegistry.execute(tc.name, tc.args), toolTimeoutMs, tc.name
                        );
                        return { ...tc, result };
                    } catch (err) {
                        return { ...tc, result: { success: false, message: err.message } };
                    }
                })
            );

            for (const r of results) {
                console.log(`  -> ${r.name}:`, r.result?.message ?? r.result);
                conversation.addToolResult(r.name, r.result);
                // Whole ToolResult, not just .data — otherwise a failure's
                // message never reaches the model and it cannot self-correct.
                messages.push({
                    role: "tool_result",
                    toolCallId: r.id,
                    toolName: r.name,
                    content: r.result,
                });
            }
        }

        if (steps >= maxSteps && !LLMresponse) {
            console.warn(`[runAgent] hit maxSteps (${maxSteps})`);
            LLMresponse =
                "I had to stop — that took more steps than expected. Here's where I got to; ask me to continue if you'd like.";
        }

        console.log("FINAL LLM RESPONSE:", LLMresponse);

        conversation.addAssistantMessage(LLMresponse);
        await createRecord(CHAT_HISTORY, conversation.build());

        await meter.finish("ok");
        return LLMresponse;
    } catch (error) {
        console.error("❌ Error in runAgent:", error);
        // Record the partial turn too — a turn that died at call 7 of a quota
        // blowout is exactly the data point worth keeping.
        await meter.finish("error");
        throw error;
    }
}
