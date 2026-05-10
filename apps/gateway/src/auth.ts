import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "./db/client.js";
import { apiKeys, tenants } from "./db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    tenant?: { id: string; name: string };
    apiKeyId?: string;
  }
}

const PUBLIC_PATHS = new Set(["/", "/healthz", "/metrics"]);

function isPublic(path: string): boolean {
  const pathOnly = path.split("?")[0] ?? path;
  if (PUBLIC_PATHS.has(pathOnly)) return true;
  // /admin/* is gated by its own X-Admin-Key check, not bearer auth.
  if (pathOnly.startsWith("/admin/")) return true;
  return false;
}

function unauthorized(reply: FastifyReply, message: string) {
  return reply.code(401).send({
    error: { type: "unauthorized", message },
  });
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function applyAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isPublic(request.url)) return;

    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return unauthorized(reply, "Missing Authorization: Bearer <key> header");
    }

    const rawKey = header.slice("Bearer ".length).trim();
    if (rawKey.length === 0) {
      return unauthorized(reply, "Empty bearer token");
    }

    const hash = hashKey(rawKey);

    const rows = db
      .select({
        keyId: apiKeys.id,
        revokedAt: apiKeys.revokedAt,
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantStatus: tenants.status,
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
      .where(eq(apiKeys.hash, hash))
      .all();

    const row = rows[0];
    if (!row) {
      request.log.warn(
        { keyPrefix: rawKey.slice(0, 12) },
        "Unknown API key"
      );
      return unauthorized(reply, "Invalid API key");
    }

    if (row.revokedAt) {
      return unauthorized(reply, "API key has been revoked");
    }

    if (row.tenantStatus !== "active") {
      return unauthorized(reply, `Tenant is ${row.tenantStatus}`);
    }

    request.tenant = { id: row.tenantId, name: row.tenantName };
    request.apiKeyId = row.keyId;
  });
}
