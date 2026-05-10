import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "llmgate" });
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: "llmgate_http_requests_total",
  help: "HTTP requests received by the gateway",
  labelNames: ["route", "method", "status"] as const,
  registers: [registry],
});

export const chatRequests = new Counter({
  name: "llmgate_chat_requests_total",
  help: "Chat completion requests processed",
  labelNames: ["tenant", "provider", "model", "status", "streamed", "cache"] as const,
  registers: [registry],
});

export const chatErrors = new Counter({
  name: "llmgate_chat_errors_total",
  help: "Chat completion attempts that errored at the upstream",
  labelNames: ["provider", "model", "error_type"] as const,
  registers: [registry],
});

export const tokensTotal = new Counter({
  name: "llmgate_tokens_total",
  help: "Tokens consumed",
  labelNames: ["tenant", "model", "kind"] as const, // kind = prompt | completion
  registers: [registry],
});

export const costUsdTotal = new Counter({
  name: "llmgate_cost_usd_total",
  help: "Estimated upstream cost in USD",
  labelNames: ["tenant", "model"] as const,
  registers: [registry],
});

export const requestLatency = new Histogram({
  name: "llmgate_request_latency_seconds",
  help: "End-to-end request latency",
  labelNames: ["route", "status", "streamed"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const streamTtfb = new Histogram({
  name: "llmgate_stream_ttfb_seconds",
  help: "Time to first byte for streamed responses",
  labelNames: ["provider", "model"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const cacheOps = new Counter({
  name: "llmgate_cache_operations_total",
  help: "Cache operations",
  labelNames: ["op"] as const, // hit | miss | bypass | skip | set
  registers: [registry],
});

export const circuitOpenGauge = new Gauge({
  name: "llmgate_circuit_open",
  help: "Number of (provider, model) circuits currently open",
  registers: [registry],
});

export const rateLimitedTotal = new Counter({
  name: "llmgate_rate_limited_total",
  help: "Requests rejected due to rate limiting",
  labelNames: ["tenant", "kind"] as const, // kind = rpm | tpm
  registers: [registry],
});

export const budgetExceededTotal = new Counter({
  name: "llmgate_budget_exceeded_total",
  help: "Requests rejected due to budget caps",
  labelNames: ["tenant", "period"] as const, // period = day | month
  registers: [registry],
});
