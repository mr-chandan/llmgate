import Fastify from "fastify";

const app = Fastify({
  logger: true,
});

app.get("/", async () => ({
  service: "llmgate",
  version: "0.0.1",
  status: "ok",
}));

app.get("/healthz", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
