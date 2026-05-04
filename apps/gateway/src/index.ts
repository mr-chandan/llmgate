import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";

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
}));

app.get("/healthz", async () => ({ ok: true }));

app.post("/v1/chat/completions", async (request, reply) => {
  const result = ChatCompletionRequestSchema.safeParse(request.body);

  if (!result.success) {
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: "Request body validation failed",
        details: result.error.format(),
      },
    });
  }

  return {
    received: result.data,
    note: "Provider integration coming in Step 4 — this just echoes for now.",
  };
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
