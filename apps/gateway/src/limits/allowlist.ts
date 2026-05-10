import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tenantConfig } from "../db/schema.js";
import type { RoutingCandidate } from "../routing/policy.js";

export interface AllowlistResult {
  allowed: RoutingCandidate[];
  blocked: Array<{
    candidate: RoutingCandidate;
    reason: "provider_not_allowed" | "model_not_allowed";
  }>;
}

export function applyAllowlists(
  tenantId: string,
  candidates: RoutingCandidate[]
): AllowlistResult {
  const cfg = db
    .select({
      providers: tenantConfig.allowedProviders,
      models: tenantConfig.allowedModels,
    })
    .from(tenantConfig)
    .where(eq(tenantConfig.tenantId, tenantId))
    .all()[0];

  const allowedProviders =
    cfg?.providers && cfg.providers.length > 0 ? new Set(cfg.providers) : null;
  const allowedModels =
    cfg?.models && cfg.models.length > 0 ? new Set(cfg.models) : null;

  if (!allowedProviders && !allowedModels) {
    return { allowed: candidates, blocked: [] };
  }

  const allowed: RoutingCandidate[] = [];
  const blocked: AllowlistResult["blocked"] = [];

  for (const c of candidates) {
    if (allowedProviders && !allowedProviders.has(c.providerId)) {
      blocked.push({ candidate: c, reason: "provider_not_allowed" });
      continue;
    }
    if (allowedModels && !allowedModels.has(c.modelId)) {
      blocked.push({ candidate: c, reason: "model_not_allowed" });
      continue;
    }
    allowed.push(c);
  }

  return { allowed, blocked };
}
