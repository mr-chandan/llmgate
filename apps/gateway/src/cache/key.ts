import { createHash } from "node:crypto";
import type { ChatCompletionRequest } from "../providers/types.js";

export type CacheDirective = "auto" | "force" | "skip";

export function parseCacheDirective(header: unknown): CacheDirective {
  if (header === "force") return "force";
  if (header === "skip") return "skip";
  return "auto";
}

export function shouldCache(
  req: ChatCompletionRequest,
  directive: CacheDirective
): boolean {
  if (directive === "skip") return false;
  if (directive === "force") return true;
  return req.temperature === 0;
}

export function buildCacheKey(
  tenantId: string,
  req: ChatCompletionRequest
): string {
  const canonical = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? null,
    max_tokens: req.max_tokens ?? null,
    stream: !!req.stream,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return `chat:${tenantId}:${hash}`;
}
