import toolRegistry from "./tools/definitions/index.js";
import { LoadSkillTool } from "./tools/definitions/LoadSkillTool.js";
import { ProviderManager, resolveMaxSteps, resolveTaskChain } from "./llm/createProvider.js";
import { startTurn } from "./llm/usageMeter.js";
import { agentConfig } from "../config/agent.config.js";
import { getUserProfile } from "../identity/userManager.js";
import { createRecord } from "../tools/mongo/createRecord.js";
import { CHAT_HISTORY, ConversationBuilder } from "../tools/mongo/schema/chatHistorySchema.js";
import { buildSystemInstruction, NO_REPLY } from "./instruction.js";
import chatHistoryKnowledge from "../knowledge/chatHistoryKnowledge.js";
import userProfileKnowledge from "../knowledge/userProfileKnowledge.js";
import chatSummaryKnowledge from "../knowledge/chatSummaryKnowledge.js";
import { localDateOf, IST_TIMEZONE } from "../tools/mongo/dateUtils.js";
import { getOpenFlowsForUser } from "../scheduler/flows/activeFlowsRepo.js";
import goodNightFlow from "./flows/goodNightFlow.js";
import goodMorningFlow from "./flows/goodMorningFlow.js";

// The wire name, taken from the class rather than repeated as a literal —
// `static name` shadows the class name, so these cannot drift apart.
const LOAD_SKILL_TOOL = LoadSkillTool.name;

/**
 * Fold any skill loaded during this step into the rest of the turn.
 *
 * Called from inside the agent loop, after tool results are pushed and before
 * the next request goes out — that ordering is the whole same-reply guarantee.
 * Mutates `messages[0].content` and `loadedSkills`; returns the widened
 * declaration list rather than mutating it, since the caller holds it in a let.
 *
 * Exported so this is tested against real results instead of by reading source:
 * it is the only place a tool result is allowed to change a turn's capabilities.
 */
export function applyLoadedSkills(results, { messages, toolDeclarations, loadedSkills, registry = toolRegistry }) {
    let declarations = toolDeclarations;

    for (const r of results) {
        if (r.name !== LOAD_SKILL_TOOL || !r.result?.success) continue;

        const { skill, instruction, toolNames = [] } = r.result.data ?? {};
        // Loading twice is a wasted step, not an error — the model sometimes
        // re-requests after a long tool chain. Re-appending would duplicate the
        // instruction in the prompt.
        if (!skill || loadedSkills.has(skill)) continue;
        loadedSkills.add(skill);

        // messages[0] is the system message. Appending keeps the skill after the
        // base rules, where recency gives it weight — the same reasoning that
        // puts the ACTIVE ROUTINE block last.
        if (instruction && messages[0]) messages[0].content += `\n\n${instruction}`;

        const added = registry
            .getDeclarationsFor(toolNames)
            .filter(d => !declarations.some(existing => existing.name === d.name));
        declarations = [...declarations, ...added];

        console.log(`[runAgent] skill "${skill}" loaded (+${added.length} tools)`);
    }

    return declarations;
}

// flowType → the flow module. Listed explicitly per known flow so the agent
// never picks up an overlay we have not vetted. Add new flows here.
const FLOWS = {
    [goodNightFlow.flowType]: goodNightFlow,
    [goodMorningFlow.flowType]: goodMorningFlow,
};

// The static half, for callers that only measure or inspect the prompt.
export const FLOW_OVERLAYS = Object.fromEntries(
    Object.entries(FLOWS).map(([flowType, flow]) => [flowType, flow.instruction])
);

/**
 * Per-flow state the overlay needs but cannot infer from the transcript.
 * Without this the scratchpad is write-only and the two-strike rule in the
 * goodMorning overlay can never fire.
 *
 * LOG DATE is the important one: it is the calendar day the flow OPENED on,
 * not the current day. A goodNight flow opens at 23:00 and is often answered
 * after midnight, when "today" in RIGHT NOW has already rolled over — so the
 * day is decided here, once, and handed to the model as a literal.
 */
export function flowStateBlock(flow, timeZone = IST_TIMEZONE) {
    const sp = flow.scratchpad || {};
    const logDate = localDateOf(flow.startedAt, timeZone);
    return [
        "-------------------------------------",
        `📌 FLOW STATE (${flow.flowType})`,
        `- LOG DATE: ${logDate ?? "unknown"}  ← the day this routine covers.`,
        `  Copy it verbatim into every date field you write in this flow.`,
        `  Do NOT use the date from RIGHT NOW, and do NOT add a time or "Z".`,
        `- unrelatedReplies so far: ${sp.unrelatedReplies ?? 0}`,
        `- opened: ${flow.startedAt ? new Date(flow.startedAt).toLocaleString("en-GB", { timeZone }) : "unknown"}`,
        "-------------------------------------",
    ].join("\n");
}

/**
 * One flow's full overlay: its procedure, its state, and — if it has one — the
 * data it needs, read fresh.
 *
 * `buildContext` is what lets a routine carry live data on the SYSTEM side. The
 * morning routine used to receive its backlog as part of the user message the
 * cron job sent, which meant the data was written once at 09:00, stored in
 * chatHistory, and replayed unchanged for the rest of the day. Asked at 15:50
 * what was still pending, the agent answered off a six-hour-old list. Rebuilding
 * per turn also means a task the model closes at 09:05 is gone from the list it
 * reads at 09:06.
 *
 * A context that fails must not cost the turn. The model is told the data is
 * missing and to fetch what it needs — which is worse than having it, and far
 * better than a routine that dies because one query timed out.
 *
 * `flows` is injectable for the same reason applyLoadedSkills takes a registry:
 * the fallback path is the one that matters and the only way to exercise it for
 * real is to hand it a context that throws.
 */
export async function buildFlowOverlay(flow, { userId, timeZone = IST_TIMEZONE, flows = FLOWS } = {}) {
    const definition = flows[flow.flowType];
    if (!definition) return null;

    const parts = [definition.instruction, flowStateBlock(flow, timeZone)];

    if (typeof definition.buildContext === "function") {
        try {
            const context = await definition.buildContext(userId, { timeZone });
            if (context) parts.push(context);
        } catch (err) {
            console.warn(`[runAgent] ${flow.flowType} live context unavailable:`, err.message);
            parts.push(
                `⚠ The live data block for this routine could not be read (${err.message}).\n` +
                `Ignore any instruction above that tells you not to fetch — you have nothing to work ` +
                `from, so read what you need with fetchRecord before planning anything.`
            );
        }
    }

    return parts.join("\n\n");
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

        // Fetched before the overlays because flowStateBlock needs the zone to
        // resolve LOG DATE — the user's calendar day, not the host's.
        let userProfile = null;
        try {
            userProfile = await getUserProfile(userId);
        } catch (e) {
            console.warn("[runAgent] user profile lookup failed, using internal keys:", e.message);
        }
        const timeZone = userProfile?.timezone || IST_TIMEZONE;

        // Active flow overlays. Lazy expiry inside getOpenFlowsForUser. keeps stale flows from leaking.
        const openFlows = await getOpenFlowsForUser(userId);
        const overlays = (await Promise.all(
            openFlows.map(f => buildFlowOverlay(f, { userId, timeZone }))
        )).filter(Boolean);

        // 3. Persona + live IST time + overlays. Rebuilt every turn.
        // The profile is rendered here rather than cached: facts change between
        // turns, and a stale block is how the agent ends up telling someone they
        // are still job hunting.
        const [profileBlock, recentBlock] = await Promise.all([
            userProfileKnowledge(userId, userProfile),
            chatSummaryKnowledge(userId, { timeZone }),
        ]);
        const systemInstruction = buildSystemInstruction(overlays, {
            profile: profileBlock,
            recent: recentBlock,
        });

        const messages = [
            { role: "system", content: systemInstruction },
            ...chatHistory,
            { role: "user", content: userInstruction },
        ];

        // Recorded so a system pass can be told apart from a conversation on the
        // way back OUT of the collection. The summarize pass persists a turn like
        // any other; without this, tomorrow's summarizer reads today's
        // summarization exchange as if the user had said it.
        const conversation = new ConversationBuilder(userId, source);
        conversation.addUserMessage(userInstruction);

        const task = resolveTask({ source, openFlows, override: taskOverride });
        const maxSteps = resolveMaxSteps(task);

        const providerManager = new ProviderManager(userProfile?.apiKeys || {}, task);
        // let, not const: a skill loaded mid-turn widens this. Declarations are
        // sent on every request rather than bound once, so the iteration after a
        // load simply advertises more tools — no chat to rebuild.
        let toolDeclarations = toolRegistry.getToolDeclarations();
        const loadedSkills = new Set();
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

            // Apply any skill loaded in this step, before the next request goes
            // out — that is what makes a skill usable in the same reply that
            // asked for it rather than the one after.
            toolDeclarations = applyLoadedSkills(results, {
                messages, toolDeclarations, loadedSkills,
            });
        }

        if (steps >= maxSteps && !LLMresponse) {
            console.warn(`[runAgent] hit maxSteps (${maxSteps})`);
            LLMresponse =
                "I had to stop — that took more steps than expected. Here's where I got to; ask me to continue if you'd like.";
        }

        // A blank reply has reached Telegram ten times since June, always on a
        // confirmation or wrap-up turn. There is no case where an empty bubble
        // is the right output: either the model meant to close the exchange,
        // which NO_REPLY expresses, or it failed, which must be visible.
        if (!LLMresponse || !LLMresponse.trim()) {
            const didWork = conversation.messages.some(m => m.role === "tool" && m.result?.success);
            console.warn(`[runAgent] empty response — substituting ${didWork ? "a fallback" : "NO_REPLY"}`);
            LLMresponse = didWork
                ? "Done — saved. Ask me if you want the details."
                : NO_REPLY;
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
