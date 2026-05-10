import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tenantConfig } from "../db/schema.js";

/**
 * In-memory fixed-window counters for both request count (RPM) and token
 * count (TPM) per tenant. Each tenant has two independent windows.
 *
 * Limitations: state is not shared across processes/replicas. Production
 * deploys should swap the implementation for a Redis-backed token bucket.
 */
interface BucketState {
  count: number;
  windowStartedAt: number;
}

const rpmBuckets = new Map<string, BucketState>();
const tpmBuckets = new Map<string, BucketState>();
const WINDOW_MS = 60_000;

export interface RateLimitResult {
  ok: boolean;
  kind?: "rpm" | "tpm";
  limit?: number;
  remaining?: number;
  retryAfterSec?: number;
}

function step(
  buckets: Map<string, BucketState>,
  tenantId: string,
  limit: number,
  amount: number
): RateLimitResult {
  const now = Date.now();
  let s = buckets.get(tenantId);
  if (!s || now - s.windowStartedAt >= WINDOW_MS) {
    s = { count: 0, windowStartedAt: now };
    buckets.set(tenantId, s);
  }
  s.count += amount;
  if (s.count > limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((s.windowStartedAt + WINDOW_MS - now) / 1000)
    );
    return { ok: false, limit, remaining: 0, retryAfterSec };
  }
  return { ok: true, limit, remaining: Math.max(0, limit - s.count) };
}

function loadConfig(tenantId: string) {
  return db
    .select({
      rpm: tenantConfig.rateLimitRpm,
      tpm: tenantConfig.rateLimitTpm,
    })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, tenantId))
    .all()[0];
}

/** Pre-flight check: increments the RPM counter by 1. */
export function checkRateLimit(tenantId: string): RateLimitResult {
  const cfg = loadConfig(tenantId);
  if (!cfg?.rpm) return { ok: true };
  const r = step(rpmBuckets, tenantId, cfg.rpm, 1);
  return r.ok ? r : { ...r, kind: "rpm" };
}

/**
 * After-the-fact accounting: increment TPM by `tokens`. Returns ok:true
 * even if it pushes over (we already produced the response). The next
 * pre-flight TPM check will reject. If you want a strict pre-flight TPM
 * gate, call checkTpmPreflight() with an estimated token count.
 */
export function recordTpm(tenantId: string, tokens: number): RateLimitResult {
  const cfg = loadConfig(tenantId);
  if (!cfg?.tpm) return { ok: true };
  return step(tpmBuckets, tenantId, cfg.tpm, Math.max(0, tokens));
}

/**
 * Pre-flight TPM check: rejects if the tenant is *already* over their
 * token-per-minute limit from previous requests.
 */
export function checkTpmPreflight(tenantId: string): RateLimitResult {
  const cfg = loadConfig(tenantId);
  if (!cfg?.tpm) return { ok: true };
  const now = Date.now();
  const s = tpmBuckets.get(tenantId);
  if (!s || now - s.windowStartedAt >= WINDOW_MS) return { ok: true, limit: cfg.tpm };
  if (s.count >= cfg.tpm) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((s.windowStartedAt + WINDOW_MS - now) / 1000)
    );
    return {
      ok: false,
      kind: "tpm",
      limit: cfg.tpm,
      remaining: 0,
      retryAfterSec,
    };
  }
  return { ok: true, limit: cfg.tpm, remaining: cfg.tpm - s.count };
}
