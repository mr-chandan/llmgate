import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

export function applyRequestId(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const id =
      typeof incoming === "string" && incoming.length > 0 && incoming.length < 128
        ? incoming
        : `req_${randomUUID()}`;
    request.requestId = id;
    reply.header("x-request-id", id);
    // child logger so every log line for this request carries the id
    request.log = request.log.child({ requestId: id });
  });
}
