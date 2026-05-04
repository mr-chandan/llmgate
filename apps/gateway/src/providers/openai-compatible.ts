import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  Provider,
} from "./types.js";

export interface OpenAICompatibleConfig {
  id: string;
  baseURL: string;
  apiKey: string;
  supports: (model: string) => boolean;
}

function mapFinishReason(
  reason: string | null | undefined
): ChatCompletionResponse["choices"][number]["finish_reason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return "stop";
  }
}

export function createOpenAICompatibleProvider(
  cfg: OpenAICompatibleConfig
): Provider {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
  });

  return {
    id: cfg.id,
    supports: cfg.supports,

    async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const response = await client.chat.completions.create({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: false,
      });

      const choice = response.choices[0];

      return {
        id: response.id ?? `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: response.created ?? Math.floor(Date.now() / 1000),
        model: response.model ?? req.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: choice?.message?.content ?? "",
            },
            finish_reason: mapFinishReason(choice?.finish_reason),
          },
        ],
        usage: {
          prompt_tokens: response.usage?.prompt_tokens ?? 0,
          completion_tokens: response.usage?.completion_tokens ?? 0,
          total_tokens: response.usage?.total_tokens ?? 0,
        },
      };
    },

    async *chatStream(req): AsyncIterable<ChatCompletionChunk> {
      const fallbackId = `chatcmpl-${randomUUID()}`;
      const fallbackCreated = Math.floor(Date.now() / 1000);

      const stream = await client.chat.completions.create({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: true,
      });

      for await (const chunk of stream) {
        yield {
          id: chunk.id ?? fallbackId,
          object: "chat.completion.chunk",
          created: chunk.created ?? fallbackCreated,
          model: chunk.model ?? req.model,
          choices: chunk.choices.map((c) => ({
            index: c.index,
            delta: {
              ...(c.delta.role === "assistant" && {
                role: "assistant" as const,
              }),
              ...(c.delta.content != null && { content: c.delta.content }),
            },
            finish_reason: c.finish_reason ?? null,
          })),
        };
      }
    },
  };
}
