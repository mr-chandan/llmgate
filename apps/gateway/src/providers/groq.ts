import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

const GROQ_MODELS = new Set([
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
]);

export function createGroqProvider(apiKey: string): Provider {
  return createOpenAICompatibleProvider({
    id: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey,
    supports: (model) => GROQ_MODELS.has(model),
  });
}
