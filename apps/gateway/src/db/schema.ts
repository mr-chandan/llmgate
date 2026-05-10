import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => ({
    hashIdx: index("api_keys_hash_idx").on(table.hash),
    tenantIdx: index("api_keys_tenant_idx").on(table.tenantId),
  })
);

export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id"),
    requestedModel: text("requested_model").notNull(),
    resolvedModel: text("resolved_model"),
    status: integer("status").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    ttfbMs: integer("ttfb_ms"),
    attempts: integer("attempts").notNull().default(1),
    retryCount: integer("retry_count").notNull().default(0),
    streamed: integer("streamed", { mode: "boolean" })
      .notNull()
      .default(false),
    cacheHit: integer("cache_hit", { mode: "boolean" })
      .notNull()
      .default(false),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    tenantIdx: index("request_logs_tenant_idx").on(
      table.tenantId,
      table.createdAt
    ),
    modelIdx: index("request_logs_model_idx").on(table.resolvedModel),
  })
);


export const tenantConfig = sqliteTable("tenant_config", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  monthlyBudgetUsd: real("monthly_budget_usd"),
  dailyBudgetUsd: real("daily_budget_usd"),
  rateLimitRpm: integer("rate_limit_rpm"),
  rateLimitTpm: integer("rate_limit_tpm"),
  allowedProviders: text("allowed_providers", { mode: "json" }).$type<
    string[] | null
  >(),
  allowedModels: text("allowed_models", { mode: "json" }).$type<
    string[] | null
  >(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});


export type Tenant = typeof tenants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type RequestLog = typeof requestLogs.$inferSelect;
export type TenantConfig = typeof tenantConfig.$inferSelect;

