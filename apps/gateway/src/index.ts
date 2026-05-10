import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { and, count, eq, gte, lte, sum } from "drizzle-orm";
import { z } from "zod";
import { applyAdmin } from "./admin.js";
import { applyAuth } from "./auth.js";
import { cache } from "./cache/memory.js";
import {
  buildCacheKey,
  parseCacheDirective,
  shouldCache,
  type CacheDirective,
} from "./cache/key.js";
import { config } from "./config.js";
import { db, runMigrations } from "./db/client.js";
import { recordRequestLog } from "./db/logger.js";
import { requestLogs } from "./db/schema.js";
import { applyAllowlists } from "./limits/allowlist.js";
import { checkBudget } from "./limits/budget.js";
import {
  checkRateLimit,
  checkTpmPreflight,
  recordTpm,
} from "./limits/rate.js";
import {
  budgetExceededTotal,
  cacheOps,
  chatErrors,
  circuitOpenGauge,
  httpRequests,
  rateLimitedTotal,
  registry as metricsRegistry,
} from "./metrics.js";
import {
  listProviders,
  pickProviderById,
} from "./providers/registry.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionUsage,
  Provider,
} from "./providers/types.js";
import { applyRequestId } from "./request-id.js";
import { circuitBreaker, circuitKey } from "./resilience/circuit.js";
import { retry } from "./resilience/retry.js";
import { withTimeout } from "./resilience/timeouts.js";
import { MODEL_REGISTRY } from "./routing/registry.js";
import { resolveCandidates, type RoutingCandidate } from "./routing/policy.js";

const CACHE_TTL_SEC = 86_400;

const app = Fastify({
  logger: { level: config.LOG_LEVEL },
});

applyRequestId(app);
applyAuth(app);
applyAdmin(app);

// Light HTTP-level metrics for every request.
app.addHook("onResponse", async (request, reply) => {
  const route = request.routeOptions?.url ?? request.url.split("?")[0];
  httpRequests.inc({
    route,
    method: request.method,
    status: String(reply.statusCode),
  });
  circuitOpenGauge.set(circuitBreaker.countOpen());
});

const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      })
    )
    .min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
});

app.get("/", async () => ({
  service: "llmgate",
  version: "0.0.1",
  status: "ok",
  env: config.NODE_ENV,
  providers: listProviders(),
}));

app.get("/healthz", async () => ({ ok: true }));

app.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", metricsRegistry.contentType);
  return metricsRegistry.metrics();
});

app.get("/v1/models", async () => {
  const activeProviders = new Set(listProviders());
  return {
    object: "list",
    data: MODEL_REGISTRY.filter((m) => activeProviders.has(m.providerId)).map(
      (m) => ({
        id: m.id,
        object: "model",
        provider: m.providerId,
        classes: m.classes,
        context_window: m.contextWindow,
        pricing: {
          input_per_mtok_usd: m.inputUsdPerMTokens,
          output_per_mtok_usd: m.outputUsdPerMTokens,
        },
      })
    ),
  };
});

app.get("/v1/usage", async (request) => {
  const tenantId = request.tenant!.id;
  const query = request.query as { from?: string; to?: string };

  const conditions = [eq(requestLogs.tenantId, tenantId)];
  if (query.from) {
    const d = new Date(query.from);
    if (!Number.isNaN(d.getTime()))
      conditions.push(gte(requestLogs.createdAt, d));
  }
  if (query.to) {
    const d = new Date(query.to);
    if (!Number.isNaN(d.getTime()))
      conditions.push(lte(requestLogs.createdAt, d));
  }
  const where = conditions.length > 1 ? and(...conditions) : conditions[0];

  const rows = db
    .select({
      model: requestLogs.resolvedModel,
      requests: count(),
      promptTokens: sum(requestLogs.promptTokens),
      completionTokens: sum(requestLogs.completionTokens),
      totalTokens: sum(requestLogs.totalTokens),
      costUsd: sum(requestLogs.costUsd),
    })
    .from(requestLogs)
    .where(where)
    .groupBy(requestLogs.resolvedModel)
    .all();

  const totals = rows.reduce(
    (acc, r) => ({
      requests: acc.requests + Number(r.requests ?? 0),
      promptTokens: acc.promptTokens + Number(r.promptTokens ?? 0),
      completionTokens:
        acc.completionTokens + Number(r.completionTokens ?? 0),
      totalTokens: acc.totalTokens + Number(r.totalTokens ?? 0),
      costUsd: acc.costUsd + Number(r.costUsd ?? 0),
    }),
    {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    }
  );

  return {
    tenant_id: tenantId,
    from: query.from ?? null,
    to: query.to ?? null,
    totals: {
      requests: totals.requests,
      tokens: {
        prompt: totals.promptTokens,
        completion: totals.completionTokens,
        total: totals.totalTokens,
      },
      cost_usd: Number(totals.costUsd.toFixed(6)),
    },
    by_model: rows.map((r) => ({
      model: r.model,
      requests: Number(r.requests ?? 0),
      tokens: {
        prompt: Number(r.promptTokens ?? 0),
        completion: Number(r.completionTokens ?? 0),
        total: Number(r.totalTokens ?? 0),
      },
      cost_usd: Number(Number(r.costUsd ?? 0).toFixed(6)),
    })),
  };
});

app.post("/v1/chat/completions", async (request, reply) => {
  const parsed = ChatCompletionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: "Request body validation failed",
        details: parsed.error.format(),
      },
    });
  }

  const tenantId = request.tenant!.id;

  // RPM rate limit (request count per minute)
  const rate = checkRateLimit(tenantId);
  if (!rate.ok) {
    rateLimitedTotal.inc({ tenant: tenantId, kind: "rpm" });
    reply.header("Retry-After", String(rate.retryAfterSec));
    reply.header("x-ratelimit-limit", String(rate.limit));
    reply.header("x-ratelimit-remaining", "0");
    return reply.code(429).send({
      error: {
        type: "rate_limit_exceeded",
        message: `Rate limit exceeded: ${rate.limit} req/min`,
        retry_after_seconds: rate.retryAfterSec,
      },
    });
  }
  if (rate.limit != null) {
    reply.header("x-ratelimit-limit", String(rate.limit));
    reply.header("x-ratelimit-remaining", String(rate.remaining));
  }

  // TPM pre-flight: reject if tenant already exceeded their token-per-minute
  // limit from previous calls in this window.
  const tpm = checkTpmPreflight(tenantId);
  if (!tpm.ok) {
    rateLimitedTotal.inc({ tenant: tenantId, kind: "tpm" });
    reply.header("Retry-After", String(tpm.retryAfterSec));
    return reply.code(429).send({
      error: {
        type: "rate_limit_exceeded",
        message: `Token-per-minute limit exceeded: ${tpm.limit} tpm`,
        retry_after_seconds: tpm.retryAfterSec,
      },
    });
  }

  const budget = checkBudget(tenantId);
  if (!budget.ok) {
    budgetExceededTotal.inc({
      tenant: tenantId,
      period: budget.period ?? "unknown",
    });
    return reply.code(402).send({
      error: {
        type: "budget_exceeded",
        message: budget.reason,
        spent_usd: Number((budget.spentUsd ?? 0).toFixed(6)),
        cap_usd: budget.capUsd,
        period: budget.period,
      },
    });
  }

  const directive = parseCacheDirective(
    request.headers["x-llmgate-cache"]
  );
  const cacheable = shouldCache(parsed.data, directive);
  const cacheKey = cacheable ? buildCacheKey(tenantId, parsed.data) : null;

  let candidates = resolveCandidates(parsed.data.model);
  if (candidates.length === 0) {
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: `No provider or class found for: ${parsed.data.model}`,
      },
    });
  }

  // Allowlist filter
  const filtered = applyAllowlists(tenantId, candidates);
  if (filtered.allowed.length === 0) {
    return reply.code(403).send({
      error: {
        type: "allowlist_violation",
        message: "All candidates blocked by tenant allowlist",
        blocked: filtered.blocked.map((b) => ({
          provider: b.candidate.providerId,
          model: b.candidate.modelId,
          reason: b.reason,
        })),
      },
    });
  }
  candidates = filtered.allowed;

  if (parsed.data.stream === true) {
    return handleStreaming(
      request,
      reply,
      parsed.data,
      candidates,
      cacheKey,
      directive
    );
  }

  return handleNonStreaming(
    request,
    reply,
    parsed.data,
    candidates,
    cacheKey,
    directive
  );
});

interface AttemptRecord {
  provider: string;
  model: string;
  error: string;
  retries?: number;
}

async function handleNonStreaming(
  request: FastifyRequest,
  reply: FastifyReply,
  req: ChatCompletionRequest,
  candidates: RoutingCandidate[],
  cacheKey: string | null,
  directive: CacheDirective
) {
  const startedAt = Date.now();
  const tenantId = request.tenant!.id;
  const apiKeyId = request.apiKeyId ?? null;
  const requestId = request.requestId;

  if (cacheKey) {
    const cached = await cache.get(cacheKey);
    if (cached?.type === "chat_completion") {
      cacheOps.inc({ op: "hit" });
      reply.header("x-llmgate-provider", cached.providerId);
      reply.header("x-llmgate-model", cached.resolvedModel);
      reply.header("x-llmgate-attempts", "0");
      reply.header("x-llmgate-cache-status", "hit");

      recordRequestLog({
        id: requestId,
        tenantId,
        apiKeyId,
        providerId: cached.providerId,
        requestedModel: req.model,
        resolvedModel: cached.resolvedModel,
        status: 200,
        latencyMs: Date.now() - startedAt,
        attempts: 0,
        retryCount: 0,
        streamed: false,
        cacheHit: true,
      });

      return cached.response;
    }
    cacheOps.inc({ op: "miss" });
  } else {
    cacheOps.inc({ op: directive === "skip" ? "skip" : "bypass" });
  }

  reply.header(
    "x-llmgate-cache-status",
    cacheKey ? "miss" : directive === "skip" ? "skip" : "bypass"
  );

  const attempts: AttemptRecord[] = [];
  let totalRetries = 0;

  for (const candidate of candidates) {
    const provider = pickProviderById(candidate.providerId);
    if (!provider) {
      attempts.push({
        provider: candidate.providerId,
        model: candidate.modelId,
        error: "provider not registered",
      });
      continue;
    }

    const cKey = circuitKey(provider.id, candidate.modelId);
    if (!circuitBreaker.tryAcquire(cKey)) {
      attempts.push({
        provider: provider.id,
        model: candidate.modelId,
        error: "circuit_open",
      });
      reply.header("x-llmgate-circuit-skipped", cKey);
      continue;
    }

    try {
      const result = await retry(
        async () => {
          const t = withTimeout(config.PROVIDER_TIMEOUT_MS);
          try {
            return await provider.chat(
              { ...req, model: candidate.modelId },
              { signal: t.signal }
            );
          } finally {
            t.cancel();
          }
        },
        {
          maxAttempts: config.PROVIDER_MAX_RETRIES,
          baseMs: config.PROVIDER_RETRY_BASE_MS,
          maxMs: config.PROVIDER_RETRY_MAX_MS,
        }
      );

      circuitBreaker.recordSuccess(cKey);
      const retries = result.attempts - 1;
      totalRetries += retries;

      reply.header("x-llmgate-provider", provider.id);
      reply.header("x-llmgate-model", candidate.modelId);
      reply.header("x-llmgate-attempts", String(attempts.length + 1));
      reply.header("x-llmgate-retries", String(retries));

      if (cacheKey) {
        await cache.set(
          cacheKey,
          {
            type: "chat_completion",
            response: result.value,
            resolvedModel: candidate.modelId,
            providerId: provider.id,
          },
          CACHE_TTL_SEC
        );
        cacheOps.inc({ op: "set" });
      }

      const usage = result.value.usage;
      recordTpm(tenantId, usage.total_tokens);

      recordRequestLog({
        id: requestId,
        tenantId,
        apiKeyId,
        providerId: provider.id,
        requestedModel: req.model,
        resolvedModel: candidate.modelId,
        status: 200,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        latencyMs: Date.now() - startedAt,
        attempts: attempts.length + 1,
        retryCount: totalRetries,
        streamed: false,
        cacheHit: false,
      });

      return result.value;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      circuitBreaker.recordFailure(cKey);
      chatErrors.inc({
        provider: provider.id,
        model: candidate.modelId,
        error_type: classifyError(err),
      });
      request.log.warn(
        { provider: provider.id, model: candidate.modelId, err: message },
        "Provider call failed; trying next candidate"
      );
      attempts.push({
        provider: provider.id,
        model: candidate.modelId,
        error: message,
      });
    }
  }

  recordRequestLog({
    id: requestId,
    tenantId,
    apiKeyId,
    requestedModel: req.model,
    status: 502,
    latencyMs: Date.now() - startedAt,
    attempts: attempts.length,
    retryCount: totalRetries,
    streamed: false,
    errorMessage: "all providers failed",
  });

  return reply.code(502).send({
    error: {
      type: "all_providers_failed",
      message: "All routing candidates failed",
      attempts,
    },
  });
}

async function handleStreaming(
  request: FastifyRequest,
  reply: FastifyReply,
  req: ChatCompletionRequest,
  candidates: RoutingCandidate[],
  cacheKey: string | null,
  directive: CacheDirective
) {
  const startedAt = Date.now();
  const tenantId = request.tenant!.id;
  const apiKeyId = request.apiKeyId ?? null;
  const requestId = request.requestId;

  if (cacheKey) {
    const cached = await cache.get(cacheKey);
    if (cached?.type === "chat_stream") {
      cacheOps.inc({ op: "hit" });
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "x-request-id": requestId,
        "x-llmgate-provider": cached.providerId,
        "x-llmgate-model": cached.resolvedModel,
        "x-llmgate-attempts": "0",
        "x-llmgate-cache-status": "hit",
      });

      for (const chunk of cached.chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();

      recordRequestLog({
        id: requestId,
        tenantId,
        apiKeyId,
        providerId: cached.providerId,
        requestedModel: req.model,
        resolvedModel: cached.resolvedModel,
        status: 200,
        latencyMs: Date.now() - startedAt,
        ttfbMs: 0,
        attempts: 0,
        retryCount: 0,
        streamed: true,
        cacheHit: true,
      });
      return;
    }
    cacheOps.inc({ op: "miss" });
  } else {
    cacheOps.inc({ op: directive === "skip" ? "skip" : "bypass" });
  }

  const attempts: AttemptRecord[] = [];

  for (const candidate of candidates) {
    const provider = pickProviderById(candidate.providerId);
    if (!provider) {
      attempts.push({
        provider: candidate.providerId,
        model: candidate.modelId,
        error: "provider not registered",
      });
      continue;
    }

    const cKey = circuitKey(provider.id, candidate.modelId);
    if (!circuitBreaker.tryAcquire(cKey)) {
      attempts.push({
        provider: provider.id,
        model: candidate.modelId,
        error: "circuit_open",
      });
      continue;
    }

    const probe = await probeStream(
      provider,
      { ...req, model: candidate.modelId },
      config.PROVIDER_TIMEOUT_MS
    );

    if ("error" in probe) {
      circuitBreaker.recordFailure(cKey);
      chatErrors.inc({
        provider: provider.id,
        model: candidate.modelId,
        error_type: "stream_probe_failed",
      });
      request.log.warn(
        {
          provider: provider.id,
          model: candidate.modelId,
          err: probe.error,
        },
        "Stream failed before first chunk; trying next candidate"
      );
      attempts.push({
        provider: provider.id,
        model: candidate.modelId,
        error: probe.error,
      });
      continue;
    }

    const ttfbMs = Date.now() - startedAt;
    let succeeded = true;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-request-id": requestId,
      "x-llmgate-provider": provider.id,
      "x-llmgate-model": candidate.modelId,
      "x-llmgate-attempts": String(attempts.length + 1),
      "x-llmgate-cache-status": cacheKey
        ? "miss"
        : directive === "skip"
        ? "skip"
        : "bypass",
    });

    const recorded: ChatCompletionChunk[] = [];
    let usage: ChatCompletionUsage | undefined;

    const writeChunk = (chunk: ChatCompletionChunk) => {
      if (chunk.usage) usage = chunk.usage;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (cacheKey) recorded.push(chunk);
    };

    let errorMessage: string | null = null;

    try {
      writeChunk(probe.first);
      for await (const chunk of probe.rest) {
        writeChunk(chunk);
      }
      res.write("data: [DONE]\n\n");
    } catch (err) {
      succeeded = false;
      errorMessage = err instanceof Error ? err.message : "unknown error";
      chatErrors.inc({
        provider: provider.id,
        model: candidate.modelId,
        error_type: "stream_mid_flight",
      });
      request.log.error(
        { provider: provider.id, model: candidate.modelId, err: errorMessage },
        "Stream errored mid-flight"
      );
      writeChunk({
        id: probe.first.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: candidate.modelId,
        choices: [
          { index: 0, delta: {}, finish_reason: "upstream_disconnect" },
        ],
      });
      res.write("data: [DONE]\n\n");
    }

    res.end();

    if (succeeded) circuitBreaker.recordSuccess(cKey);
    else circuitBreaker.recordFailure(cKey);

    if (cacheKey && succeeded) {
      await cache.set(
        cacheKey,
        {
          type: "chat_stream",
          chunks: recorded,
          resolvedModel: candidate.modelId,
          providerId: provider.id,
        },
        CACHE_TTL_SEC
      );
      cacheOps.inc({ op: "set" });
    }

    if (usage) recordTpm(tenantId, usage.total_tokens);

    recordRequestLog({
      id: requestId,
      tenantId,
      apiKeyId,
      providerId: provider.id,
      requestedModel: req.model,
      resolvedModel: candidate.modelId,
      status: 200,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      totalTokens: usage?.total_tokens,
      latencyMs: Date.now() - startedAt,
      ttfbMs,
      attempts: attempts.length + 1,
      retryCount: 0,
      streamed: true,
      cacheHit: false,
      errorMessage,
    });

    return;
  }

  recordRequestLog({
    id: requestId,
    tenantId,
    apiKeyId,
    requestedModel: req.model,
    status: 502,
    latencyMs: Date.now() - startedAt,
    attempts: attempts.length,
    retryCount: 0,
    streamed: true,
    errorMessage: "all streaming candidates failed before first chunk",
  });

  return reply.code(502).send({
    error: {
      type: "all_providers_failed",
      message: "All streaming candidates failed before first chunk",
      attempts,
    },
  });
}

async function probeStream(
  provider: Provider,
  req: ChatCompletionRequest,
  timeoutMs: number
): Promise<
  | { first: ChatCompletionChunk; rest: AsyncIterable<ChatCompletionChunk> }
  | { error: string }
> {
  const t = withTimeout(timeoutMs);
  try {
    const iterable = provider.chatStream(req, { signal: t.signal });
    const iterator = iterable[Symbol.asyncIterator]();
    const firstResult = await iterator.next();

    if (firstResult.done || !firstResult.value) {
      t.cancel();
      return { error: "stream ended with no chunks" };
    }

    // The stream lives past this function; cancel only the first-byte timer.
    t.cancel();

    const rest: AsyncIterable<ChatCompletionChunk> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return iterator.next();
          },
        };
      },
    };

    return { first: firstResult.value, rest };
  } catch (err) {
    t.cancel();
    return {
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  if (err.name === "TimeoutError") return "timeout";
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    if (status === 429) return "rate_limited";
    if (status >= 500) return "5xx";
    if (status >= 400) return "4xx";
  }
  if (/network|fetch failed|econnreset|econnrefused/i.test(err.message ?? ""))
    return "network";
  return "other";
}

try {
  runMigrations();
  app.log.info("Migrations applied");
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
