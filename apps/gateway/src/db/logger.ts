import { randomBytes } from "node:crypto";
import {
  chatRequests,
  costUsdTotal,
  requestLatency,
  streamTtfb,
  tokensTotal,
} from "../metrics.js";
import { computeCost } from "../routing/registry.js";
import { db } from "./client.js";
import { requestLogs } from "./schema.js";

export interface RequestLogParams {
  /** request id; used as the row id so logs and metrics correlate. */
  id?: string;
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
  retryCount?: number;
  streamed: boolean;
  errorMessage?: string | null;
  cacheHit?: boolean;
}

export function recordRequestLog(p: RequestLogParams): void {
  const promptTokens = p.promptTokens ?? 0;
  const completionTokens = p.completionTokens ?? 0;
  const totalTokens = p.totalTokens ?? promptTokens + completionTokens;
  const costUsd = p.resolvedModel
    ? computeCost(p.resolvedModel, promptTokens, completionTokens)
    : 0;
  const id = p.id ?? `req_${randomBytes(8).toString("hex")}`;

  db.insert(requestLogs)
    .values({
      id,
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
      retryCount: p.retryCount ?? 0,
      streamed: p.streamed,
      cacheHit: p.cacheHit ?? false,
      errorMessage: p.errorMessage ?? null,
    })
    .run();

  // Mirror to Prometheus metrics so /metrics has live counters.
  const labels = {
    tenant: p.tenantId,
    provider: p.providerId ?? "none",
    model: p.resolvedModel ?? p.requestedModel,
    status: String(p.status),
    streamed: p.streamed ? "true" : "false",
    cache: p.cacheHit ? "hit" : "miss",
  };
  chatRequests.inc(labels);
  if (promptTokens > 0)
    tokensTotal.inc(
      { tenant: p.tenantId, model: labels.model, kind: "prompt" },
      promptTokens
    );
  if (completionTokens > 0)
    tokensTotal.inc(
      { tenant: p.tenantId, model: labels.model, kind: "completion" },
      completionTokens
    );
  if (costUsd > 0)
    costUsdTotal.inc({ tenant: p.tenantId, model: labels.model }, costUsd);

  requestLatency.observe(
    {
      route: "chat.completions",
      status: String(p.status),
      streamed: p.streamed ? "true" : "false",
    },
    p.latencyMs / 1000
  );
  if (p.ttfbMs != null && p.streamed) {
    streamTtfb.observe(
      { provider: p.providerId ?? "none", model: labels.model },
      p.ttfbMs / 1000
    );
  }
}
