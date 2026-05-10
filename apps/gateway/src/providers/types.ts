export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length" | "content_filter" | "tool_calls";
  }>;
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }>;
  /**
   * Per the OpenAI streaming protocol with `stream_options.include_usage`,
   * the final chunk may carry token usage. Adapters set this on the last
   * chunk they emit when usage is known.
   */
  usage?: ChatCompletionUsage;
}

export interface ProviderCallContext {
  signal?: AbortSignal;
}

export interface Provider {
  id: string;
  supports(model: string): boolean;
  chat(
    req: ChatCompletionRequest,
    ctx?: ProviderCallContext
  ): Promise<ChatCompletionResponse>;
  chatStream(
    req: ChatCompletionRequest,
    ctx?: ProviderCallContext
  ): AsyncIterable<ChatCompletionChunk>;
}
