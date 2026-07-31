import { GoogleGenAI } from "@google/genai";
import { agentConfig } from "../config/agent.config.js";

export const gemini_ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Single source of truth with the provider layer, so the live path and the
// ported ProviderManager can never drift onto different models.
export const gemini_model = agentConfig.llm.models.gemini;
