import { and, eq, gte, sum } from "drizzle-orm";
import { db } from "../db/client.js";
import { requestLogs, tenantConfig } from "../db/schema.js";

export interface BudgetCheckResult {
  ok: boolean;
  reason?: string;
  spentUsd?: number;
  capUsd?: number;
  period?: "day" | "month";
}

function startOfDayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfMonthUtc(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function sumCostSince(tenantId: string, since: Date): number {
  const row = db
    .select({ total: sum(requestLogs.costUsd) })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.tenantId, tenantId),
        gte(requestLogs.createdAt, since)
      )
    )
    .all()[0];
  return Number(row?.total ?? 0);
}

export function checkBudget(tenantId: string): BudgetCheckResult {
  const cfg = db
    .select({
      daily: tenantConfig.dailyBudgetUsd,
      monthly: tenantConfig.monthlyBudgetUsd,
    })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, tenantId))
    .all()[0];

  if (!cfg) return { ok: true };

  if (cfg.daily != null) {
    const spent = sumCostSince(tenantId, startOfDayUtc());
    if (spent >= cfg.daily) {
      return {
        ok: false,
        reason: "daily budget exceeded",
        spentUsd: spent,
        capUsd: cfg.daily,
        period: "day",
      };
    }
  }

  if (cfg.monthly != null) {
    const spent = sumCostSince(tenantId, startOfMonthUtc());
    if (spent >= cfg.monthly) {
      return {
        ok: false,
        reason: "monthly budget exceeded",
        spentUsd: spent,
        capUsd: cfg.monthly,
        period: "month",
      };
    }
  }

  return { ok: true };
}
