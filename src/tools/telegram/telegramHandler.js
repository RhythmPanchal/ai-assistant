import { getUserProfile, updateUserProfile, createUserProfile } from "../../agent/userManager.js";
import { sendMessage, editMessage, createThinkingAnimation } from "./sendMessage.js";

// In-memory state machine for onboarding & configuration
const userStates = new Map();

export async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";

  // Handle explicit commands
  if (text.startsWith("/start")) {
    await handleStartCommand(chatId);
    return;
  }

  if (text.startsWith("/configure_ai")) {
    await handleConfigureAiCommand(chatId);
    return;
  }

  // Check ongoing state machine flows
  const state = userStates.get(chatId);
  if (state) {
      if (state.flow === "onboarding") {
          await handleOnboardingState(chatId, text, state);
          return;
      } else if (state.flow === "configure_ai") {
          await handleConfigureAiState(chatId, text, state);
          return;
      }
  }

  // Standard LLM routing (check if user exists first)
  const user = await getUserProfile(chatId);
  if (!user) {
      await handleStartCommand(chatId);
      return;
  }

  // Normal agent flow
  if (text && text.length > 2000) {
      await sendMessage(chatId, "⚠️ Your message is too long (limit: 2000 characters). Please shorten it.");
      return;
  }

  const thinking = await createThinkingAnimation(chatId);
  try {
    // Dynamically import runAgent to avoid circular dependencies if any
    const { runAgent } = await import("../../agent/agent.js");
    const reply = await runAgent(chatId, text, user); // Passing user profile to the agent
    
    thinking.stop();

    if (thinking.messageId) {
      await editMessage(chatId, thinking.messageId, reply);
    } else {
      await sendMessage(chatId, reply);
    }
  } catch (error) {
    console.error("[handleTelegramMessage] error:", error);
    thinking.stop();

    const errorReply = `⚠️ *Something went wrong*\n\n🪲 \`${String(error.message || error).slice(0, 200)}\``;
    if (thinking.messageId) {
      await editMessage(chatId, thinking.messageId, errorReply);
    } else {
      await sendMessage(chatId, errorReply);
    }
  }
}

async function handleStartCommand(chatId) {
    const user = await getUserProfile(chatId);
    if (user) {
        await sendMessage(chatId, `Welcome back, ${user.name}! How can I help you today?\n\n(Use /configure_ai to manage your API keys)`);
        return;
    }

    // Start onboarding
    userStates.set(chatId, { flow: "onboarding", step: 1, data: {} });
    await sendMessage(chatId, "Hello! I am Rasmalai, your personal AI assistant. Let's get to know each other.\n\nFirst, what is your name?");
}

async function handleOnboardingState(chatId, text, state) {
    if (state.step === 1) {
        state.data.name = text;
        state.step = 2;
        await sendMessage(chatId, `Nice to meet you, ${state.data.name}! How old are you?`);
    } else if (state.step === 2) {
        state.data.age = parseInt(text) || text;
        state.step = 3;
        await sendMessage(chatId, `Got it. What is your profession or current occupation?`);
    } else if (state.step === 3) {
        state.data.profession = text;
        state.step = 4;
        await sendMessage(chatId, `What does your typical daily schedule look like? (e.g. Work 10-6, Sleep 11-7)`);
    } else if (state.step === 4) {
        state.data.dailySchedule = text;
        
        // Save to DB
        await createUserProfile(chatId, {
            name: state.data.name,
            age: state.data.age,
            profession: state.data.profession,
            dailySchedule: state.data.dailySchedule,
            lifestyle: "",
            timezone: "Asia/Kolkata",
            apiKeys: {},
            preferences: { triggersOptIn: true }
        });
        
        userStates.delete(chatId);
        await sendMessage(chatId, `Awesome! You are all set up. I am ready to assist you.\n\n(Note: I default to Gemini. To add Groq or Mistral keys, type /configure_ai)`);
    }
}

async function handleConfigureAiCommand(chatId) {
    userStates.set(chatId, { flow: "configure_ai", step: "choose_provider" });
    await sendMessage(chatId, "Please type the name of the AI provider you want to configure:\n\nOptions: mistral, groq, gemini, openrouter, nvidia");
}

async function handleConfigureAiState(chatId, text, state) {
    if (text.toLowerCase() === "cancel") {
        userStates.delete(chatId);
        await sendMessage(chatId, "Configuration cancelled.");
        return;
    }

    if (state.step === "choose_provider") {
        const provider = text.toLowerCase().trim();
        const valid = ["mistral", "groq", "gemini", "openrouter", "nvidia"];
        if (!valid.includes(provider)) {
            await sendMessage(chatId, "Invalid provider. Please type one of: mistral, groq, gemini, openrouter, nvidia (or 'cancel')");
            return;
        }
        state.provider = provider;
        state.step = "enter_key";
        await sendMessage(chatId, `Great! Please paste your API key for ${provider}.\n\n(Type 'cancel' to abort)`);
    } else if (state.step === "enter_key") {
        const { updateUserApiKeys } = await import("../../agent/userManager.js");
        await updateUserApiKeys(chatId, state.provider, text.trim());
        userStates.delete(chatId);
        await sendMessage(chatId, `Successfully saved your ${state.provider} API key!`);
    }
}