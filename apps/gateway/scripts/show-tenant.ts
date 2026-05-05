import { createHash } from "node:crypto";
import { and, eq, gte, sum } from "drizzle-orm";
import { db } from "../src/db/client.js";
import {
  apiKeys,
  requestLogs,
  tenantConfig,
  tenants,
} from "../src/db/schema.js";

const rawKey = process.argv[2];
if (!rawKey) {
  console.error("Usage: pnpm tsx scripts/show-tenant.ts <llmg_...>");
  process.exit(1);
}

const hash = createHash("sha256").update(rawKey).digest("hex");
const row = db
  .select({
    keyPrefix: apiKeys.prefix,
    revokedAt: apiKeys.revokedAt,
    tenantId: tenants.id,
    tenantName: tenants.name,
    tenantStatus: tenants.status,
  })
  .from(apiKeys)
  .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
  .where(eq(apiKeys.hash, hash))
  .all()[0];

if (!row) {
  console.error("No matching API key.");
  process.exit(1);
}

console.log("Key prefix:    ", row.keyPrefix);
console.log("Tenant:        ", row.tenantId, "(" + row.tenantName + ")");
console.log("Tenant status: ", row.tenantStatus);
console.log("Key revoked:   ", row.revokedAt ?? "no");

const cfg = db
  .select()
  .from(tenantConfig)
  .where(eq(tenantConfig.tenantId, row.tenantId))
  .all()[0];

console.log("\n-- tenant_config --");
console.log(cfg ?? "(NO ROW — treated as UNLIMITED, this is your bug)");

const startOfDay = new Date();
startOfDay.setUTCHours(0, 0, 0, 0);
const startOfMonth = new Date();
startOfMonth.setUTCDate(1);
startOfMonth.setUTCHours(0, 0, 0, 0);

const dailyTotal = Number(
  db
    .select({ total: sum(requestLogs.costUsd) })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.tenantId, row.tenantId),
        gte(requestLogs.createdAt, startOfDay)
      )
    )
    .all()[0]?.total ?? 0
);
const monthlyTotal = Number(
  db
    .select({ total: sum(requestLogs.costUsd) })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.tenantId, row.tenantId),
        gte(requestLogs.createdAt, startOfMonth)
      )
    )
    .all()[0]?.total ?? 0
);

console.log("\nDaily spend so far  (UTC):", dailyTotal);
console.log("Monthly spend so far (UTC):", monthlyTotal);
