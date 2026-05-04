import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export type Tenant = typeof tenants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
