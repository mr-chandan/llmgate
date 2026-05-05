import { randomBytes } from "node:crypto";
import { computeCost } from "../routing/registry.js";
import { db } from "./client.js";
import { requestLogs } from "./schema.js";

export interface RequestLogParams {
  tenantId: string;
  apiKeyId?: string | null;
  providerId?: string | null;
  requestedModel: string;
  resolvedModel?: string | null;
  status: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  ttfbMs?: number | null;
  attempts: number;
  streamed: boolean;
  errorMessage?: string | null;
}

export function recordRequestLog(p: RequestLogParams): void {
  const promptTokens = p.promptTokens ?? 0;
  const completionTokens = p.completionTokens ?? 0;
  const totalTokens = p.totalTokens ?? promptTokens + completionTokens;
  const costUsd = p.resolvedModel
    ? computeCost(p.resolvedModel, promptTokens, completionTokens)
    : 0;

  db.insert(requestLogs)
    .values({
      id: `req_${randomBytes(8).toString("hex")}`,
      tenantId: p.tenantId,
      apiKeyId: p.apiKeyId ?? null,
      providerId: p.providerId ?? null,
      requestedModel: p.requestedModel,
      resolvedModel: p.resolvedModel ?? null,
      status: p.status,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
      latencyMs: p.latencyMs,
      ttfbMs: p.ttfbMs ?? null,
      attempts: p.attempts,
      streamed: p.streamed,
      errorMessage: p.errorMessage ?? null,
    })
    .run();
}
