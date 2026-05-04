export interface ModelInfo {
  id: string;
  providerId: string;
  inputUsdPerMTokens: number;
  outputUsdPerMTokens: number;
  contextWindow: number;
  classes: string[];
}

export const MODEL_REGISTRY: ModelInfo[] = [
  // Gemini (Google)
  {
    id: "gemini-2.5-flash",
    providerId: "gemini",
    inputUsdPerMTokens: 0.3,
    outputUsdPerMTokens: 2.5,
    contextWindow: 1_000_000,
    classes: ["balanced", "fast", "long-context"],
  },
  {
    id: "gemini-2.5-pro",
    providerId: "gemini",
    inputUsdPerMTokens: 1.25,
    outputUsdPerMTokens: 10.0,
    contextWindow: 2_000_000,
    classes: ["frontier", "long-context"],
  },

  // Groq (Llama / Mixtral)
  {
    id: "llama-3.1-8b-instant",
    providerId: "groq",
    inputUsdPerMTokens: 0.05,
    outputUsdPerMTokens: 0.08,
    contextWindow: 131_072,
    classes: ["cheap", "fast"],
  },
  {
    id: "llama-3.3-70b-versatile",
    providerId: "groq",
    inputUsdPerMTokens: 0.59,
    outputUsdPerMTokens: 0.79,
    contextWindow: 131_072,
    classes: ["balanced", "fast"],
  },
];

export function findModel(id: string): ModelInfo | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

export function findModelsByClass(className: string): ModelInfo[] {
  return MODEL_REGISTRY.filter((m) => m.classes.includes(className));
}

export function totalCostScore(m: ModelInfo): number {
  return m.inputUsdPerMTokens + m.outputUsdPerMTokens;
}
