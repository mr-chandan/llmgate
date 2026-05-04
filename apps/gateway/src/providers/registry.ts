import { config } from "../config.js";
import { geminiProvider } from "./gemini.js";
import { createGroqProvider } from "./groq.js";
import type { Provider } from "./types.js";

const providers: Provider[] = [geminiProvider];

if (config.GROQ_API_KEY) {
  providers.push(createGroqProvider(config.GROQ_API_KEY));
}

export function pickProvider(model: string): Provider | undefined {
  return providers.find((p) => p.supports(model));
}

export function pickProviderById(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}

export function listProviders(): string[] {
  return providers.map((p) => p.id);
}
