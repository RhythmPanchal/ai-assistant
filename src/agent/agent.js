import toolRegistry from "./tools/definitions/index.js";
import { LoadSkillTool } from "./tools/definitions/LoadSkillTool.js";
import { CompleteFlowTool } from "./tools/definitions/CompleteFlowTool.js";
import { ToolResult } from "./tools/BaseTool.js";
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
import { localDateOf, IST_TIMEZONE, datesForModel } from "../tools/mongo/dateUtils.js";
import { getOpenFlowsForUser, extendFlow } from "../scheduler/flows/activeFlowsRepo.js";
import goodNightFlow from "./flows/goodNightFlow.js";
import goodMorningFlow from "./flows/goodMorningFlow.js";
import onboardingFlow, { classifyReply, createSkipGuard } from "./flows/onboardingFlow.js";
import { routineNudge, notesUpkeep, ROUTINE_FLOW_TYPES } from "./flows/routineNotes.js";

/**
 * The replies runAgent substitutes when the model produced nothing usable.
 *
 * Exported so a caller that needs a real message — a routine opener, which is
 * sent to the user unprompted — can tell one of these apart from something the
 * model actually wrote, and fall back instead of delivering "I had to stop".
 */
export const STEP_LIMIT_REPLY =
    "I had to stop — that took more steps than expected. Here's where I got to; ask me to continue if you'd like.";
export const WORK_DONE_REPLY = "Done — saved. Ask me if you want the details.";

// The wire name, taken from the class rather than repeated as a literal —
// `static name` shadows the class name, so these cannot drift apart.
const LOAD_SKILL_TOOL = LoadSkillTool.name;
const COMPLETE_FLOW_TOOL = CompleteFlowTool.name;

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
    [onboardingFlow.flowType]: onboardingFlow,
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
export async function buildFlowOverlay(flow, { userId, timeZone = IST_TIMEZONE, profile = null, flows = FLOWS } = {}) {
    const definition = flows[flow.flowType];
    if (!definition) return null;

    const parts = [definition.instruction, flowStateBlock(flow, timeZone)];

    if (typeof definition.buildContext === "function") {
        try {
            // `flow` so a context can read the routine's own state — the night
            // block needs its LOG DATE (from startedAt) and its scratchpad.
            // `profile` is the users document runAgent already loaded, so a
            // context about the person (onboarding's) costs no query of its own.
            const context = await definition.buildContext(userId, { timeZone, flow, profile });
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
// Onboarding last: a routine firing mid-review is the point of that moment, and
// runAgent hides the onboarding overlay while one is open anyway.
const FLOW_TASK_PRECEDENCE = ["goodNight", "goodMorning", "onboarding"];

/**
 * The flows that shape this turn. Onboarding steps aside while a routine is open.
 *
 * That only happens to someone already onboarded who sends /start near a
 * routine hour — a first-time user has no routines until onboarding finishes.
 * Two overlays each driving the conversation would ask two sets of questions in
 * one reply; the routine is the one with a clock on it.
 */
export function flowsForTurn(openFlows = []) {
    const routineOpen = openFlows.some(f => ROUTINE_FLOW_TYPES.includes(f.flowType));
    return routineOpen ? openFlows.filter(f => f.flowType !== onboardingFlow.flowType) : openFlows;
}

/**
 * Add the tools a flow declares for its own turns. Onboarding sets a timezone
 * and check-in times on nearly every run, and updateUserSettings is otherwise
 * skill-loaded — a skill round trip in front of each would be pure waste.
 * Deduplicated, since a skill loaded later in the turn may add the same tool.
 */
export function withFlowTools(declarations, activeFlows = [], { flows = FLOWS, registry = toolRegistry } = {}) {
    const names = activeFlows.flatMap(f => flows[f.flowType]?.toolNames ?? []);
    if (!names.length) return declarations;
    const added = registry.getDeclarationsFor(names)
        .filter((d, i, all) => !declarations.some(e => e.name === d.name) && all.findIndex(x => x.name === d.name) === i);
    return [...declarations, ...added];
}

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

/**
 * Remembers each write that succeeded in this turn, so an IDENTICAL one in a
 * later step is not run again.
 *
 * A model that loses track of its own results calls the same write again, and
 * again. In the night eval one turn saved the same ₹30 expense eight times
 * before the step limit stopped it. Whatever makes a model spin — a wrong date
 * on screen, a fallback model, a history it misreads — this caps the damage
 * at one row.
 *
 * Narrow on purpose:
 *  - reads are never guarded; re-reading after a write is how the model sees
 *    what changed
 *  - only a call from an EARLIER step counts. Two identical calls in one step
 *    are one message asking for two things — two rickshaws, ₹50 each
 *  - only a call that SUCCEEDED counts, so a failed write can be retried
 *  - identical means same tool and same arguments, key order aside
 *
 * `registry` is injectable for the same reason applyLoadedSkills takes one.
 */
export function createRepeatGuard(registry = toolRegistry) {
    const done = new Map();
    const keyOf = (tc) => `${tc.name}:${stableStringify(tc.args ?? {})}`;
    return {
        /** The earlier result if this exact write already succeeded in an earlier step, else null. */
        earlier(tc, step) {
            if (registry.isReadOnly(tc.name)) return null;
            const hit = done.get(keyOf(tc));
            return hit && hit.step < step ? hit.result : null;
        },
        record(tc, result, step) {
            if (registry.isReadOnly(tc.name) || !result?.success) return;
            const key = keyOf(tc);
            if (!done.has(key)) done.set(key, { step, result });
        },
    };
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object" && !(value instanceof Date)) {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/**
 * Run one step's tool calls: in parallel, except completeFlow, which starts once
 * the rest have finished. Results come back in the order the calls were made.
 *
 * A close is judged on what the step saved. Run alongside the step's writes,
 * onboarding's check read the notes before they landed and refused an
 * onboarding that was finished — and the model then overwrote a real answer to
 * get past the refusal.
 */
export async function runStepCalls(toolCalls, run, { last = [COMPLETE_FLOW_TOOL] } = {}) {
    const results = new Array(toolCalls.length);
    const phase = (inPhase) => Promise.all(toolCalls.map(async (tc, i) => {
        if (inPhase(tc)) results[i] = await run(tc);
    }));
    await phase(tc => !last.includes(tc.name));
    await phase(tc => last.includes(tc.name));
    return results;
}

// Consecutive steps in which every call was a refused repeat. At this many the
// model is going round in circles, and the turn ends rather than spending the
// rest of maxSteps on it.
const MAX_IDLE_REPEAT_STEPS = 2;

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
        // Fetched first because the history window and flowStateBlock both
        // need the zone — the user's wall clock, not the host's.
        let userProfile = null;
        try {
            userProfile = await getUserProfile(userId);
        } catch (e) {
            console.warn("[runAgent] user profile lookup failed, using internal keys:", e.message);
        }
        const timeZone = userProfile?.timezone || IST_TIMEZONE;

        // Their day, which ends at dayStartHour and not at midnight.
        const { history: chatHistory, carriedFrom } = await chatHistoryKnowledge(userId, {
            timeZone,
            dayStartHour: userProfile?.preferences?.dayStartHour,
        });

        // Active flow overlays. Lazy expiry inside getOpenFlowsForUser. keeps stale flows from leaking.
        const openFlows = await getOpenFlowsForUser(userId);
        const activeFlows = flowsForTurn(openFlows);

        // An idle-expiring flow ends a fixed time after the LAST message, not the
        // first: every turn it shapes pushes its expiry forward. A failure costs
        // the extension, never the turn.
        const now = new Date();
        await Promise.all(activeFlows
            .filter(f => FLOWS[f.flowType]?.idleMinutes)
            .map(f => extendFlow(f._id, new Date(now.getTime() + FLOWS[f.flowType].idleMinutes * 60 * 1000))
                .catch(err => console.warn(`[runAgent] could not extend ${f.flowType}:`, err.message))));

        // While onboarding is open, a note saying nothing ("Prefers not to say.",
        // "None.") is saved only in reply to a question they turned down — see
        // createSkipGuard. Their message is read by code; a job's trigger turns
        // nothing down.
        const skipGuard = activeFlows.some(f => f.flowType === onboardingFlow.flowType)
            ? createSkipGuard({
                reply: source === "telegram" ? classifyReply(userInstruction) : undefined,
                notes: userProfile?.notes,
            })
            : null;

        const [routineOverlays, nudge] = await Promise.all([
            Promise.all(activeFlows.map(f => buildFlowOverlay(f, { userId, timeZone, profile: userProfile }))),
            // Once a week at most, and only inside a routine — see routineNotes.js.
            // Claimed here, once per turn, rather than per flow: with both
            // routines open two claims would race for the same week.
            routineNudge(openFlows, { userId }),
        ]);
        // Notes come first. A routine's own procedure and live data stay last,
        // where recency gives them the most weight: raising a goal or tidying
        // the notes is something a routine may do on the way, never its point.
        const overlays = [nudge, notesUpkeep(openFlows), ...routineOverlays].filter(Boolean);

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
            carriedFrom,
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

        const task = resolveTask({ source, openFlows: activeFlows, override: taskOverride });
        const maxSteps = resolveMaxSteps(task);
        meter.setTask(task);

        const providerManager = new ProviderManager(userProfile?.apiKeys || {}, task);
        // let, not const: a skill loaded mid-turn widens this. Declarations are
        // sent on every request rather than bound once, so the iteration after a
        // load simply advertises more tools — no chat to rebuild.
        let toolDeclarations = withFlowTools(toolRegistry.getToolDeclarations(), activeFlows);
        const loadedSkills = new Set();
        const toolTimeoutMs = agentConfig.llm.toolTimeoutMs;

        const chain = resolveTaskChain(task).map(e => `${e.provider}:${e.model}`).join(" -> ");
        console.log(`[runAgent] task=${task} maxSteps=${maxSteps}\n  chain: ${chain}`);
        console.log("User Query:", userInstruction);

        let LLMresponse = "";
        let steps = 0;
        const repeatGuard = createRepeatGuard();
        let idleRepeatSteps = 0;

        // Each iteration is at least one billable request, so the loop is bounded.
        while (steps < maxSteps) {
            steps++;
            meter.recordStep();

            let response;
            try {
                response = await providerManager.chatWithFallback(messages, toolDeclarations, {
                    // Per MODEL, not per provider — each has its own daily
                    // bucket, so that is the granularity worth tracking.
                    onAttempt: (provider, model) => meter.recordCall(`${provider}:${model}`),
                    // Fires on failures too, so a fallback cascade is priced
                    // rather than silently dropped.
                    onResult: (info) => meter.recordResult(info),
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

            // Independent calls run in parallel, completeFlow after them — see
            // runStepCalls. toolRegistry.execute already converts a throw into
            // a failed ToolResult, so only the timeout needs catching here.
            const results = await runStepCalls(response.toolCalls, async (tc) => {
                const earlier = repeatGuard.earlier(tc, steps);
                if (earlier) {
                    console.warn(`[runAgent] step ${steps}: ${tc.name} repeats a write that already succeeded this turn — not run again`);
                    return {
                        ...tc,
                        repeated: true,
                        result: new ToolResult(
                            true,
                            `Already done earlier in this turn with exactly these arguments, so it was NOT run again. ` +
                            `Earlier result: ${earlier.message} Do not call it again — tell the user what was done.`,
                            earlier.data
                        ),
                    };
                }
                // Checked before any await, so calls are judged in the order made.
                const refused = skipGuard?.check(tc);
                if (refused) {
                    console.warn(`[runAgent] step ${steps}: ${tc.name} refused — ${refused}`);
                    return { ...tc, result: new ToolResult(false, `Not saved: ${refused}`) };
                }
                try {
                    const result = await withTimeout(
                        toolRegistry.execute(tc.name, tc.args), toolTimeoutMs, tc.name
                    );
                    skipGuard?.record(tc, result);
                    return { ...tc, result };
                } catch (err) {
                    return { ...tc, result: { success: false, message: err.message } };
                }
            });

            // After the whole step, so identical calls within one step all run.
            for (const r of results) if (!r.repeated) repeatGuard.record(r, r.result, steps);

            for (const r of results) {
                console.log(`  -> ${r.name}:`, r.result?.message ?? r.result);
                conversation.addToolResult(r.name, r.result);
                // Whole ToolResult, not just .data — otherwise a failure's
                // message never reaches the model and it cannot self-correct.
                //
                // Dates rewritten to local time on the way in. Both providers
                // serialise a Date as UTC, so every IST-midnight row read as the
                // day before, and a model that trusts what it reads "fixes" a
                // correctly dated row by deleting and re-creating it. IST, not
                // the profile zone: it is the zone toIST stores in. chatHistory
                // keeps the raw result.
                messages.push({
                    role: "tool_result",
                    toolCallId: r.id,
                    toolName: r.name,
                    content: datesForModel(r.result),
                });
            }

            // Apply any skill loaded in this step, before the next request goes
            // out — that is what makes a skill usable in the same reply that
            // asked for it rather than the one after.
            toolDeclarations = applyLoadedSkills(results, {
                messages, toolDeclarations, loadedSkills,
            });

            if (results.every((r) => r.repeated)) {
                idleRepeatSteps++;
                if (idleRepeatSteps >= MAX_IDLE_REPEAT_STEPS) {
                    console.warn(`[runAgent] ${idleRepeatSteps} steps of nothing but repeated writes — ending the turn`);
                    break;
                }
            } else {
                idleRepeatSteps = 0;
            }
        }

        if (steps >= maxSteps && !LLMresponse) {
            console.warn(`[runAgent] hit maxSteps (${maxSteps})`);
            LLMresponse = STEP_LIMIT_REPLY;
        }

        // A blank reply has reached Telegram ten times since June, always on a
        // confirmation or wrap-up turn. There is no case where an empty bubble
        // is the right output: either the model meant to close the exchange,
        // which NO_REPLY expresses, or it failed, which must be visible.
        if (!LLMresponse || !LLMresponse.trim()) {
            const didWork = conversation.messages.some(m => m.role === "tool" && m.result?.success);
            console.warn(`[runAgent] empty response — substituting ${didWork ? "a fallback" : "NO_REPLY"}`);
            LLMresponse = didWork ? WORK_DONE_REPLY : NO_REPLY;
        }

        console.log("FINAL LLM RESPONSE:", LLMresponse);

        conversation.addAssistantMessage(LLMresponse);

        // Computed before the write so one set of figures serves the document,
        // the caller and the daily rollup. summary() does no I/O; finish()
        // persists, and must therefore come after.
        const metrics = meter.summary("ok");
        conversation.setMetrics(metrics);
        await createRecord(CHAT_HISTORY, conversation.build());

        await meter.finish("ok");
        return { text: LLMresponse, metrics };
    } catch (error) {
        console.error("❌ Error in runAgent:", error);
        // Record the partial turn too — a turn that died at call 7 of a quota
        // blowout is exactly the data point worth keeping.
        await meter.finish("error");
        throw error;
    }
}
