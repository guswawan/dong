import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | null = null;

/** Lazy init — avoids side effects during `next build` page-data collection. */
export function getGeminiClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}
