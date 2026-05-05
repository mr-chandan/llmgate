import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { runMigrations } from "./db/client.js";
import { applyAuth } from "./auth.js";
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
    return handleStreaming(request, reply, parsed.data, candidates);
  }

  return handleNonStreaming(request, reply, parsed.data, candidates);
});

async function handleNonStreaming(
  request: FastifyRequest,
  reply: FastifyReply,
  req: ChatCompletionRequest,
  candidates: RoutingCandidate[]
) {
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
  candidates: RoutingCandidate[]
) {
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

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-llmgate-provider": provider.id,
      "x-llmgate-model": candidate.modelId,
      "x-llmgate-attempts": String(attempts.length + 1),
    });

    const writeChunk = (chunk: ChatCompletionChunk) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    request.raw.on("close", () => {
      if (!res.writableEnded) {
        request.log.info("Client disconnected mid-stream");
      }
    });

    try {
      writeChunk(probeResult.first);
      for await (const chunk of probeResult.rest) {
        writeChunk(chunk);
      }
      res.write("data: [DONE]\n\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      request.log.error(
        { provider: provider.id, model: candidate.modelId, err: message },
        "Stream errored mid-flight"
      );
      const errChunk: ChatCompletionChunk = {
        id: probeResult.first.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: candidate.modelId,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "upstream_disconnect",
          },
        ],
      };
      writeChunk(errChunk);
      res.write("data: [DONE]\n\n");
    }

    res.end();
    return;
  }

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

