import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { and, count, eq, gte, lte, sum } from "drizzle-orm";
import { z } from "zod";
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
import { checkBudget } from "./limits/budget.js";
import { checkRateLimit } from "./limits/rate.js";
import {
  listProviders,
  pickProviderById,
} from "./providers/registry.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  Provider,
} from "./providers/types.js";
import { MODEL_REGISTRY } from "./routing/registry.js";
import { resolveCandidates, type RoutingCandidate } from "./routing/policy.js";

const CACHE_TTL_SEC = 86_400;

const app = Fastify({
  logger: { level: config.LOG_LEVEL },
});

applyAuth(app);

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

  const rate = checkRateLimit(tenantId);
  if (!rate.ok) {
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

  const budget = checkBudget(tenantId);
  if (!budget.ok) {
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

  const candidates = resolveCandidates(parsed.data.model);
  if (candidates.length === 0) {
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: `No provider or class found for: ${parsed.data.model}`,
      },
    });
  }

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

  if (cacheKey) {
    const cached = await cache.get(cacheKey);
    if (cached?.type === "chat_completion") {
      reply.header("x-llmgate-provider", cached.providerId);
      reply.header("x-llmgate-model", cached.resolvedModel);
      reply.header("x-llmgate-attempts", "0");
      reply.header("x-llmgate-cache-status", "hit");

      recordRequestLog({
        tenantId,
        apiKeyId,
        providerId: cached.providerId,
        requestedModel: req.model,
        resolvedModel: cached.resolvedModel,
        status: 200,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - startedAt,
        attempts: 0,
        streamed: false,
        cacheHit: true,
      });

      return cached.response;
    }
  }

  reply.header(
    "x-llmgate-cache-status",
    cacheKey ? "miss" : directive === "skip" ? "skip" : "bypass"
  );

  const attempts: Array<{ provider: string; model: string; error: string }> =
    [];

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

    try {
      const response = await provider.chat({
        ...req,
        model: candidate.modelId,
      });

      reply.header("x-llmgate-provider", provider.id);
      reply.header("x-llmgate-model", candidate.modelId);
      reply.header("x-llmgate-attempts", String(attempts.length + 1));

      if (cacheKey) {
        await cache.set(
          cacheKey,
          {
            type: "chat_completion",
            response,
            resolvedModel: candidate.modelId,
            providerId: provider.id,
          },
          CACHE_TTL_SEC
        );
      }

      recordRequestLog({
        tenantId,
        apiKeyId,
        providerId: provider.id,
        requestedModel: req.model,
        resolvedModel: candidate.modelId,
        status: 200,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
        latencyMs: Date.now() - startedAt,
        attempts: attempts.length + 1,
        streamed: false,
        cacheHit: false,
      });

      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
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
    tenantId,
    apiKeyId,
    requestedModel: req.model,
    status: 502,
    latencyMs: Date.now() - startedAt,
    attempts: attempts.length,
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

  if (cacheKey) {
    const cached = await cache.get(cacheKey);
    if (cached?.type === "chat_stream") {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
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
        tenantId,
        apiKeyId,
        providerId: cached.providerId,
        requestedModel: req.model,
        resolvedModel: cached.resolvedModel,
        status: 200,
        latencyMs: Date.now() - startedAt,
        ttfbMs: 0,
        attempts: 0,
        streamed: true,
        cacheHit: true,
      });
      return;
    }
  }

  const attempts: Array<{ provider: string; model: string; error: string }> =
    [];

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

    const probeResult = await probeStream(provider, {
      ...req,
      model: candidate.modelId,
    });

    if ("error" in probeResult) {
      request.log.warn(
        {
          provider: provider.id,
          model: candidate.modelId,
          err: probeResult.error,
        },
        "Stream failed before first chunk; trying next candidate"
      );
      attempts.push({
        provider: provider.id,
        model: candidate.modelId,
        error: probeResult.error,
      });
      continue;
    }

    const ttfbMs = Date.now() - startedAt;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
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
    const writeChunk = (chunk: ChatCompletionChunk) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (cacheKey) recorded.push(chunk);
    };

    let errorMessage: string | null = null;

    try {
      writeChunk(probeResult.first);
      for await (const chunk of probeResult.rest) {
        writeChunk(chunk);
      }
      res.write("data: [DONE]\n\n");
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "unknown error";
      request.log.error(
        { provider: provider.id, model: candidate.modelId, err: errorMessage },
        "Stream errored mid-flight"
      );
      writeChunk({
        id: probeResult.first.id,
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

    if (cacheKey && !errorMessage) {
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
    }

    recordRequestLog({
      tenantId,
      apiKeyId,
      providerId: provider.id,
      requestedModel: req.model,
      resolvedModel: candidate.modelId,
      status: 200,
      latencyMs: Date.now() - startedAt,
      ttfbMs,
      attempts: attempts.length + 1,
      streamed: true,
      cacheHit: false,
      errorMessage,
    });

    return;
  }

  recordRequestLog({
    tenantId,
    apiKeyId,
    requestedModel: req.model,
    status: 502,
    latencyMs: Date.now() - startedAt,
    attempts: attempts.length,
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
  req: ChatCompletionRequest
): Promise<
  | { first: ChatCompletionChunk; rest: AsyncIterable<ChatCompletionChunk> }
  | { error: string }
> {
  try {
    const iterable = provider.chatStream(req);
    const iterator = iterable[Symbol.asyncIterator]();
    const firstResult = await iterator.next();

    if (firstResult.done || !firstResult.value) {
      return { error: "stream ended with no chunks" };
    }

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
    return {
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

try {
  runMigrations();
  app.log.info("Migrations applied");
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}