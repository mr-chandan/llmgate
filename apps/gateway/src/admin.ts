import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gte, lte, sum } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { apiKeys, requestLogs, tenantConfig, tenants } from "./db/schema.js";

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function makeApiKey() {
  const raw = `llmg_${randomBytes(20).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}

const CreateTenantSchema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(["active", "suspended"]).default("active"),
  config: z
    .object({
      monthly_budget_usd: z.number().nullable().optional(),
      daily_budget_usd: z.number().nullable().optional(),
      rate_limit_rpm: z.number().int().positive().nullable().optional(),
      rate_limit_tpm: z.number().int().positive().nullable().optional(),
      allowed_providers: z.array(z.string()).nullable().optional(),
      allowed_models: z.array(z.string()).nullable().optional(),
    })
    .optional(),
});

const UpdateConfigSchema = z.object({
  monthly_budget_usd: z.number().nullable().optional(),
  daily_budget_usd: z.number().nullable().optional(),
  rate_limit_rpm: z.number().int().positive().nullable().optional(),
  rate_limit_tpm: z.number().int().positive().nullable().optional(),
  allowed_providers: z.array(z.string()).nullable().optional(),
  allowed_models: z.array(z.string()).nullable().optional(),
});

const CreateKeySchema = z.object({
  label: z.string().max(200).optional(),
});

const UpdateTenantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

export function applyAdmin(app: FastifyInstance): void {
  // Gate /admin/* with X-Admin-Key against config.ADMIN_API_KEY.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/admin/")) return;

    if (!config.ADMIN_API_KEY) {
      return reply.code(503).send({
        error: {
          type: "admin_disabled",
          message: "ADMIN_API_KEY is not configured",
        },
      });
    }
    const provided = request.headers["x-admin-key"];
    if (provided !== config.ADMIN_API_KEY) {
      return reply.code(401).send({
        error: {
          type: "unauthorized",
          message: "Missing or invalid X-Admin-Key header",
        },
      });
    }
  });

  app.get("/admin/tenants", async () => {
    const rows = db
      .select({
        id: tenants.id,
        name: tenants.name,
        status: tenants.status,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .all();
    return { data: rows };
  });

  app.post("/admin/tenants", async (request, reply) => {
    const parsed = CreateTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          details: parsed.error.format(),
        },
      });
    }
    const tenantId = makeId("tnt");
    db.insert(tenants)
      .values({
        id: tenantId,
        name: parsed.data.name,
        status: parsed.data.status,
      })
      .run();
    db.insert(tenantConfig)
      .values({
        tenantId,
        monthlyBudgetUsd: parsed.data.config?.monthly_budget_usd ?? null,
        dailyBudgetUsd: parsed.data.config?.daily_budget_usd ?? null,
        rateLimitRpm: parsed.data.config?.rate_limit_rpm ?? null,
        rateLimitTpm: parsed.data.config?.rate_limit_tpm ?? null,
        allowedProviders: parsed.data.config?.allowed_providers ?? null,
        allowedModels: parsed.data.config?.allowed_models ?? null,
      })
      .run();
    return reply.code(201).send({
      id: tenantId,
      name: parsed.data.name,
      status: parsed.data.status,
    });
  });

  app.patch("/admin/tenants/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = UpdateTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          details: parsed.error.format(),
        },
      });
    }
    const updates: Partial<typeof tenants.$inferInsert> = {};
    if (parsed.data.name) updates.name = parsed.data.name;
    if (parsed.data.status) updates.status = parsed.data.status;
    if (Object.keys(updates).length === 0) return { ok: true };

    db.update(tenants).set(updates).where(eq(tenants.id, id)).run();
    return { ok: true };
  });

  app.get("/admin/tenants/:id/config", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const row = db
      .select()
      .from(tenantConfig)
      .where(eq(tenantConfig.tenantId, id))
      .all()[0];
    if (!row) return reply.code(404).send({ error: { type: "not_found" } });
    return { data: row };
  });

  app.put("/admin/tenants/:id/config", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = UpdateConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          details: parsed.error.format(),
        },
      });
    }
    const updates: Partial<typeof tenantConfig.$inferInsert> = {};
    if (parsed.data.monthly_budget_usd !== undefined)
      updates.monthlyBudgetUsd = parsed.data.monthly_budget_usd;
    if (parsed.data.daily_budget_usd !== undefined)
      updates.dailyBudgetUsd = parsed.data.daily_budget_usd;
    if (parsed.data.rate_limit_rpm !== undefined)
      updates.rateLimitRpm = parsed.data.rate_limit_rpm;
    if (parsed.data.rate_limit_tpm !== undefined)
      updates.rateLimitTpm = parsed.data.rate_limit_tpm;
    if (parsed.data.allowed_providers !== undefined)
      updates.allowedProviders = parsed.data.allowed_providers;
    if (parsed.data.allowed_models !== undefined)
      updates.allowedModels = parsed.data.allowed_models;

    const existing = db
      .select({ tenantId: tenantConfig.tenantId })
      .from(tenantConfig)
      .where(eq(tenantConfig.tenantId, id))
      .all();
    if (existing.length === 0) {
      db.insert(tenantConfig)
        .values({
          tenantId: id,
          ...updates,
        })
        .run();
    } else {
      db.update(tenantConfig)
        .set(updates)
        .where(eq(tenantConfig.tenantId, id))
        .run();
    }
    return { ok: true };
  });

  app.get("/admin/tenants/:id/keys", async (request) => {
    const id = (request.params as { id: string }).id;
    const rows = db
      .select({
        id: apiKeys.id,
        prefix: apiKeys.prefix,
        label: apiKeys.label,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, id))
      .all();
    return { data: rows };
  });

  app.post("/admin/tenants/:id/keys", async (request, reply) => {
    const tenantId = (request.params as { id: string }).id;
    const exists = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .all();
    if (exists.length === 0) {
      return reply.code(404).send({ error: { type: "tenant_not_found" } });
    }
    const parsed = CreateKeySchema.safeParse(request.body ?? {});
    const label = parsed.success ? parsed.data.label : undefined;
    const key = makeApiKey();
    const id = makeId("key");
    db.insert(apiKeys)
      .values({
        id,
        tenantId,
        hash: key.hash,
        prefix: key.prefix,
        label: label ?? null,
      })
      .run();
    return reply.code(201).send({
      id,
      tenant_id: tenantId,
      api_key: key.raw,
      prefix: key.prefix,
      warning: "Save api_key now; only the hash is stored.",
    });
  });

  app.delete("/admin/keys/:keyId", async (request) => {
    const keyId = (request.params as { keyId: string }).keyId;
    db.update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId))
      .run();
    return { ok: true };
  });

  app.get("/admin/tenants/:id/usage", async (request) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as { from?: string; to?: string };
    const conditions = [eq(requestLogs.tenantId, id)];
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

    const byModel = db
      .select({
        model: requestLogs.resolvedModel,
        requests: count(),
        promptTokens: sum(requestLogs.promptTokens),
        completionTokens: sum(requestLogs.completionTokens),
        costUsd: sum(requestLogs.costUsd),
      })
      .from(requestLogs)
      .where(where)
      .groupBy(requestLogs.resolvedModel)
      .all();

    return {
      tenant_id: id,
      from: query.from ?? null,
      to: query.to ?? null,
      by_model: byModel.map((r) => ({
        model: r.model,
        requests: Number(r.requests ?? 0),
        prompt_tokens: Number(r.promptTokens ?? 0),
        completion_tokens: Number(r.completionTokens ?? 0),
        cost_usd: Number(Number(r.costUsd ?? 0).toFixed(6)),
      })),
    };
  });
}
