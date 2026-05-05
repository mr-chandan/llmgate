import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tenantConfig } from "../db/schema.js";

interface BucketState {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, BucketState>();
const WINDOW_MS = 60_000;

export interface RateLimitResult {
  ok: boolean;
  limit?: number;
  remaining?: number;
  retryAfterSec?: number;
}

export function checkRateLimit(tenantId: string): RateLimitResult {
  const cfg = db
    .select({ rpm: tenantConfig.rateLimitRpm })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, tenantId))
    .all()[0];

  if (!cfg?.rpm) return { ok: true };
  const limit = cfg.rpm;

  const now = Date.now();
  let state = buckets.get(tenantId);

  if (!state || now - state.windowStartedAt >= WINDOW_MS) {
    state = { count: 0, windowStartedAt: now };
    buckets.set(tenantId, state);
  }

  state.count += 1;

  if (state.count > limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((state.windowStartedAt + WINDOW_MS - now) / 1000)
    );
    return { ok: false, limit, remaining: 0, retryAfterSec };
  }

  return { ok: true, limit, remaining: Math.max(0, limit - state.count) };
}
