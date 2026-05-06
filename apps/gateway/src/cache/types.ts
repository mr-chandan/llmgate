import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../providers/types.js";

export interface CachedChatCompletion {
  type: "chat_completion";
  response: ChatCompletionResponse;
  resolvedModel: string;
  providerId: string;
}

export interface CachedChatStream {
  type: "chat_stream";
  chunks: ChatCompletionChunk[];
  resolvedModel: string;
  providerId: string;
}

export type CacheEntry = CachedChatCompletion | CachedChatStream;

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(prefix?: string): Promise<void>;
}
