import { sendMessage } from "../../tools/telegram/sendMessage.js";
import { openFlow, getOpenFlowsForUser } from "../flows/activeFlowsRepo.js";
import { onboardingFlow } from "../../agent/flows/onboardingFlow.js";
import { ROUTINE_FLOW_TYPES } from "../../agent/flows/routineNotes.js";
import { getUserProfile } from "../../identity/userManager.js";
import { claimWelcome } from "../../tools/mongo/operation/onboarding.js";
import { runAgent, STEP_LIMIT_REPLY, WORK_DONE_REPLY } from "../../agent/agent.js";
import { NO_REPLY } from "../../agent/instruction.js";
import { runWithUserContext } from "../../identity/userContext.js";

// Shorter than this is not a question — a fragment of a failed generation.
// "How old are you?" is sixteen characters.
const MIN_QUESTION_CHARS = 10;

/**
 * What a first-time user is sent before the first question — once, ever.
 *
 * Fixed text, not generated: it is the first thing anyone sees, it has to
 * describe what the bot can actually do, and a model writing it would be free to
 * promise things it cannot. Their Telegram name goes in, with a way to change
 * it, so nobody spends a question on "what should I call you?".
 */
export function welcomeMessage(name) {
    const greeting = name ? `👋 Hi ${name} — welcome to *Rasmalai*.` : "👋 Welcome to *Rasmalai*.";
    return [
        greeting,
        "",
        "I keep your tasks, money, food and day in order — and I remember what you're working towards.",
        "",
        "*Just text me like you'd text a friend:*",
        "• \"spent 250 on an auto\" → logged as an expense",
        "• \"had poha for breakfast\" → added to today's meals",
        "• \"remind me to call mom at 7\" → reminder set",
        "• \"I want to go to the gym 3x a week\" → I'll hold you to it",
        "",
        "*Every day (switch off anytime):* 🌅 a morning plan · 🌙 a night wrap-up. They start once we're set up, and I'll ask what times suit you.",
        "",
        "You can connect Google Calendar too, and send /start anytime to go over what I know about you.",
        "",
        `${name ? `I'll call you ${name} — tell me if you'd rather something else. ` : ""}A few quick questions to get you set up 👇`,
    ].join("\n");
}

/** Sent instead of starting a review while a routine is open. */
export const ROUTINE_FIRST_MESSAGE =
    "Let's finish today's check-in first — send /start again once we're done, and we'll go over what I know about you.";

const FALLBACK_QUESTION = {
    firstTime: "To start — how old are you?",
    review: "Let's go over what I know about you. Is everything I have on file still right, or has something changed?",
};

export const onboardingMode = (profile) => (profile?.onboardedAt ? "review" : "firstTime");

/**
 * Never onboarded and never welcomed. True of a brand-new account, and of every
 * account made before onboarding existed — eight on prod when it shipped, whose
 * /start had been answered as small talk. Their next message of any kind is
 * their first contact with onboarding.
 * Once welcomed it is false, so an abandoned onboarding is never forced again —
 * /start resumes it.
 */
export const neverOnboarded = (profile) => Boolean(profile) && !profile.onboardedAt && !profile.welcomedAt;

/**
 * The question that opens onboarding, written by the agent with the flow
 * already open — or a fixed one when that fails.
 *
 * NEVER throws. An onboarding with no question is a welcome followed by silence,
 * so every failure — an error, NO_REPLY, a canned runAgent substitute, a
 * fragment — sends the fixed question instead. `generated` says which one went
 * out. `run` is injectable so that fallback can be tested for real.
 */
export async function composeOnboardingQuestion(userId, mode, { run = runAgent, address = null } = {}) {
    const fallback = { text: FALLBACK_QUESTION[mode] ?? FALLBACK_QUESTION.firstTime, generated: false };
    try {
        const { text } = await runWithUserContext(
            { userId, channel: "telegram", address, reason: "userOnboardingJob" },
            () => run(userId, onboardingFlow.buildTriggerPrompt(mode), "userOnboardingJob")
        );
        const question = text?.trim();
        const unusable = !question
            || question === NO_REPLY
            || question === STEP_LIMIT_REPLY
            || question === WORK_DONE_REPLY
            || question.length < MIN_QUESTION_CHARS;
        if (unusable) {
            console.warn(`[userOnboardingJob] question for ${userId} came back unusable (${JSON.stringify(question?.slice(0, 40))}) — sending the fixed one`);
            return fallback;
        }
        return { text: question, generated: true };
    } catch (err) {
        console.error(`[userOnboardingJob] question for ${userId} failed (${err.message}) — sending the fixed one`);
        return fallback;
    }
}

/**
 * Start (or restart) onboarding for one user.
 *
 * Triggered two ways, both from the Telegram handler: /start, and a brand-new
 * user's first message. Code decides the mode — firstTime until onboardedAt is
 * set, review after — and the model never has to work it out.
 *
 * Re-running is safe: openFlow supersedes an open onboarding, and the welcome is
 * a claim that succeeds once per user, ever.
 *
 * @param {object}  args
 * @param {number}  args.userId
 * @param {string|number} args.chatId      where to deliver
 * @param {boolean} [args.askQuestion]     false for a first message that is not
 *                  /start: the agent's reply to that message asks the question
 */
export async function userOnboardingJob({ userId, chatId, askQuestion = true, send = sendMessage, run = runAgent, now = new Date() }) {
    const profile = await getUserProfile(userId);
    if (!profile) throw new Error(`[userOnboardingJob] no users row for userId ${userId}`);

    const mode = onboardingMode(profile);

    // A routine open right now outranks a review: runAgent would hide the
    // onboarding overlay behind it, so the review would open and then never be
    // seen. Only someone already onboarded can be here — a first-time user has
    // no routines until onboarding finishes.
    const open = await getOpenFlowsForUser(userId);
    if (open.some(f => ROUTINE_FLOW_TYPES.includes(f.flowType))) {
        await send(chatId, ROUTINE_FIRST_MESSAGE);
        console.log(`[userOnboardingJob] ${userId} is mid-routine — review deferred`);
        return { mode, deferred: true, welcomed: false, question: null, generated: false };
    }

    await openFlow({
        userId,
        flowType: onboardingFlow.flowType,
        expiresAt: onboardingFlow.computeExpiry(profile.timezone, now),
    });

    let welcomed = false;
    if (mode === "firstTime" && await claimWelcome(userId, now)) {
        await send(chatId, welcomeMessage(profile.name));
        welcomed = true;
    }

    if (!askQuestion) {
        console.log(`[userOnboardingJob] ${mode} onboarding opened for ${userId}${welcomed ? ", welcomed" : ""}`);
        return { mode, welcomed, question: null, generated: false };
    }

    const { text, generated } = await composeOnboardingQuestion(userId, mode, { run, address: chatId });
    await send(chatId, text);
    console.log(`[userOnboardingJob] ${mode} onboarding opened for ${userId}${welcomed ? ", welcomed" : ""}, ${generated ? "written" : "fixed"} question`);
    return { mode, welcomed, question: text, generated };
}
