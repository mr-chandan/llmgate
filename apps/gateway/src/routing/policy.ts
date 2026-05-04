import { pickProvider } from "../providers/registry.js";
import {
  findModel,
  findModelsByClass,
  totalCostScore,
} from "./registry.js";

export interface RoutingCandidate {
  providerId: string;
  modelId: string;
}

/**
 * Decide which (provider, model) pairs to try, in order.
 *
 * Resolution order:
 *   1. Virtual class (e.g., "cheap") — return all matching models, cheapest first.
 *   2. Exact model in our registry.
 *   3. Pass-through: ask providers if any of them support this model.
 */
export function resolveCandidates(requested: string): RoutingCandidate[] {
  const classMatches = findModelsByClass(requested);
  if (classMatches.length > 0) {
    return classMatches
      .slice()
      .sort((a, b) => totalCostScore(a) - totalCostScore(b))
      .map((m) => ({ providerId: m.providerId, modelId: m.id }));
  }

  const exact = findModel(requested);
  if (exact) {
    return [{ providerId: exact.providerId, modelId: exact.id }];
  }

  const provider = pickProvider(requested);
  if (provider) {
    return [{ providerId: provider.id, modelId: requested }];
  }

  return [];
}
