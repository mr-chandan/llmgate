import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import {
  listProviders,
  pickProviderById,
} from "./providers/registry.js";
import { MODEL_REGISTRY } from "./routing/registry.js";
import { resolveCandidates } from "./routing/policy.js";

const app = Fastify({
  logger: { level: config.LOG_LEVEL },
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

  const attempts: Array<{ provider: string; model: string; error: string }> =
    [];

  for (const candidate of candidates) {
    const provider = pickProviderById(candidate.providerId);
    if (!provider) {
      attempts.push({
        provider: candidate.providerId,
        model: candidate.modelId,
        error: "provider not registered (missing API key?)",
      });
      continue;
    }

    try {
      const response = await provider.chat({
        ...parsed.data,
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
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
