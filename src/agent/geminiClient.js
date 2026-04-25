// import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleGenAI, Type } from "@google/genai";

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
export const gemini_ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY});
export const gemini_model = "gemini-3.1-flash-lite-preview"