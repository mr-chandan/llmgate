import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Provider,
} from "./types.js";

const client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

function toGeminiContents(messages: ChatCompletionRequest["messages"]) {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  return {
    systemInstruction: systemText || undefined,
    contents,
  };
}

function mapFinishReason(
  reason: string | undefined
): ChatCompletionResponse["choices"][number]["finish_reason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return "stop";
  }
}

export const geminiProvider: Provider = {
  id: "gemini",

  supports(model) {
    return model.startsWith("gemini-");
  },

  async chat(req) {
    const { systemInstruction, contents } = toGeminiContents(req.messages);

    const response = await client.models.generateContent({
      model: req.model,
      contents,
      config: {
        systemInstruction,
        temperature: req.temperature,
        maxOutputTokens: req.max_tokens,
      },
    });

    const text = response.text ?? "";
    const finishReason = mapFinishReason(
      response.candidates?.[0]?.finishReason
    );
    const usage = response.usageMetadata;

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: usage?.promptTokenCount ?? 0,
        completion_tokens: usage?.candidatesTokenCount ?? 0,
        total_tokens: usage?.totalTokenCount ?? 0,
      },
    };
  },
};
