# llmgate

A multi-tenant LLM gateway. One OpenAI-compatible HTTP endpoint in front, multiple providers behind, plus the boring-but-critical glue every serious AI product eventually needs: per-tenant auth, budgets, rate limits, routing with failover, retries, circuit breakers, response caching, structured logs, Prometheus metrics, and a SQLite-backed audit trail.

```
client (any OpenAI SDK)
       │
       ▼
   POST /v1/chat/completions  ──▶  auth ─▶ rate ─▶ budget ─▶ cache ─▶ route ─▶ retry+timeout+circuit ─▶ provider
                                                                                                                │
                                                                                                                ▼
                                                                                                            response
                                                                                                                │
                                                                                                                ▼
                                                                                                       request_logs (SQLite)
                                                                                                       /v1/usage  /metrics
```

---

## 30-second quickstart

You need **Node 20+** and **pnpm**. (Tested on Node 24 + pnpm 10.)

```bash
git clone <repo> llmgate
cd llmgate

cp apps/gateway/.env.example apps/gateway/.env
# open apps/gateway/.env and set GEMINI_API_KEY (required)
# optionally set GROQ_API_KEY (free tier at https://console.groq.com/keys)

pnpm install
pnpm --filter @llmgate/gateway db:seed   # creates a tenant + API key, prints the key
pnpm dev
```

The seed script prints something like:

```
Tenant ID:  tnt_a3f9b2c10e4d8a91
API Key:    llmg_3f9c1a2b8d7e4f6a5c9b2e0a4d3f7e1b8c6a9d2f
```

Save the key. Then:

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer llmg_3f9c1a2b..." \
  -H "Content-Type: application/json" \
  -d '{"model":"cheap","messages":[{"role":"user","content":"hi"}]}'
```

Or point any OpenAI SDK at `http://localhost:4000/v1` with the `llmg_...` key as `OPENAI_API_KEY`.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | none | Service banner + active providers |
| GET | `/healthz` | none | Liveness check |
| GET | `/metrics` | none | Prometheus exposition |
| GET | `/v1/models` | bearer | List models the gateway will serve, with pricing |
| POST | `/v1/chat/completions` | bearer | Chat completions, OpenAI-shape, streaming or not |
| GET | `/v1/usage` | bearer | This tenant's spend, optionally `?from=2026-05-01&to=...` |
| `*` | `/admin/*` | `X-Admin-Key` | Tenant/key/config CRUD (see below) |

### Response headers worth knowing

- `x-request-id` — unique per request, also written to the `request_logs.id` row. Use this when filing bug reports.
- `x-llmgate-provider`, `x-llmgate-model` — what actually served the request.
- `x-llmgate-attempts` — number of candidates tried (1 = first try worked).
- `x-llmgate-retries` — retry count within the winning candidate.
- `x-llmgate-cache-status` — `hit`, `miss`, `bypass` (uncacheable), `skip` (client opted out).
- `x-ratelimit-limit`, `x-ratelimit-remaining`, `Retry-After` — when rate limits apply.
- `x-llmgate-circuit-skipped` — if a candidate was skipped because its circuit was open.

---

## Environment variables

| Name | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | Get one at https://aistudio.google.com/apikey |
| `GROQ_API_KEY` | no | — | Free at https://console.groq.com/keys |
| `DATABASE_URL` | no | `./dev.sqlite` | Path to SQLite file (Postgres swap is described in DESIGN.md) |
| `PORT` / `HOST` | no | `4000` / `127.0.0.1` | Where the gateway listens |
| `LOG_LEVEL` | no | `info` | `trace` `debug` `info` `warn` `error` `fatal` |
| `NODE_ENV` | no | `development` | |
| `PROVIDER_TIMEOUT_MS` | no | `60000` | Per-call upstream timeout |
| `PROVIDER_MAX_RETRIES` | no | `2` | Bounded retries on transient errors (within one candidate) |
| `PROVIDER_RETRY_BASE_MS` | no | `250` | Backoff base |
| `PROVIDER_RETRY_MAX_MS` | no | `4000` | Backoff cap |
| `CIRCUIT_FAILURE_THRESHOLD` | no | `5` | Failures within window to open circuit |
| `CIRCUIT_WINDOW_MS` | no | `30000` | Rolling window for failure counting |
| `CIRCUIT_OPEN_MS` | no | `30000` | How long the circuit stays open before half-open probe |
| `ENABLE_CHAOS` | no | `false` | If `true`, registers the `chaos` provider for failure injection |
| `ADMIN_API_KEY` | no | — | If set, enables `/admin/*` REST. Pass via `X-Admin-Key` header |

---

## Multi-tenancy

Every request is keyed to a tenant via the `Authorization: Bearer llmg_...` header. Per-tenant policies live in the `tenant_config` table:

- `monthly_budget_usd`, `daily_budget_usd` — pre-flight budget gates → 402 when exceeded
- `rate_limit_rpm`, `rate_limit_tpm` — request and token rate limits → 429 with `Retry-After`
- `allowed_providers`, `allowed_models` — JSON arrays; if non-null, requests are filtered → 403 if all candidates blocked

A tenant exhausting their budget cannot affect another tenant. State lives in SQLite + per-process counters; see DESIGN.md for the production scaling story.

### Issuing a new tenant + key (admin API)

```bash
ADMIN=$ADMIN_API_KEY  # set this in your .env first
curl -s -X POST http://localhost:4000/admin/tenants \
  -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"acme","config":{"monthly_budget_usd":50,"rate_limit_rpm":60}}'
# -> {"id":"tnt_...","name":"acme","status":"active"}

curl -s -X POST http://localhost:4000/admin/tenants/tnt_.../keys \
  -H "X-Admin-Key: $ADMIN"
# -> {"id":"key_...","tenant_id":"tnt_...","api_key":"llmg_...","prefix":"llmg_..."}
```

If `ADMIN_API_KEY` is not set, `/admin/*` returns 503. Use `pnpm --filter @llmgate/gateway db:seed` for one-shot tenant creation without admin auth.

---

## Routing

The default policy is **cost-optimized model-class routing with failover**.

A request can ask for:
- An **exact model** (`gemini-2.5-flash`, `llama-3.1-8b-instant`).
- A **virtual class** (`cheap`, `balanced`, `frontier`, `fast`, `long-context`). Resolved to a list of real models, sorted cheapest-first.
- An **arbitrary string** — passed through if any registered provider claims to support it.

The handler walks the candidate list in order. For each candidate:
1. If its `(provider, model)` circuit is **open**, skip.
2. Wrap the call in a per-attempt **timeout** (`PROVIDER_TIMEOUT_MS`).
3. **Retry** transient errors (5xx, 429, network, timeout) with bounded jittered exponential backoff (`PROVIDER_MAX_RETRIES`).
4. On non-transient or exhausted-retry failure: **record failure** to the circuit, **fall through** to the next candidate.
5. On success: **record success** (closes any open circuit), return the response.

Streaming uses pre-commit failover: we peek the first chunk before sending headers. If even that fails, we silently try the next candidate. Once bytes have left the building, we can't take them back — a mid-stream error emits a synthetic final chunk with `finish_reason: "upstream_disconnect"` and ends the SSE stream cleanly.

---

## Caching

A response is cached when the request is deterministic (`temperature: 0`) or the client opts in via `x-llmgate-cache: force`. Pass `x-llmgate-cache: skip` to bypass.

- **Key**: SHA-256 of (model, messages, temperature, max_tokens, stream), prefixed by tenant id. Tenant-scoped by default.
- **TTL**: 24h.
- **Streaming**: each chunk is recorded during the live stream, then replayed on a hit as SSE indistinguishable from a real upstream.
- **Backend**: in-memory `MemoryCacheStore` implementing a `CacheStore` interface. Swapping for Redis is one file.
- **Invalidation**: TTL is the primary lever. Manual `cache.clear(prefix)` is wired but not yet exposed via admin API.

---

## Failure injection (chaos provider)

Set `ENABLE_CHAOS=true` in `.env` and restart. Then call any of these models:

| Model id | Behavior |
|---|---|
| `chaos-ok` | Returns "ok" |
| `chaos-fail` | Always throws (synthetic 500) |
| `chaos-fail-rate-50` | 50% of calls throw |
| `chaos-slow-2000` | Sleep 2000ms then return |
| `chaos-timeout-90000` | Sleep past `PROVIDER_TIMEOUT_MS` |
| `chaos-stream-cut-mid` | Streams 3 tokens then errors |
| `chaos-rate-limit` | Throws with status 429 |
| `chaos-server-error` | Throws with status 500 |

**To exercise the resilience path:**

```bash
# Hit the same broken model 6+ times — circuit opens after 5 failures
for i in 1 2 3 4 5 6; do
  curl -s -X POST http://localhost:4000/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d '{"model":"chaos-fail","messages":[{"role":"user","content":"hi"}]}' \
    -o /dev/null -w "attempt %{http_code}\n" -i 2>&1 | grep -E "x-llmgate|HTTP/" || true
done
```

You'll see retries, then circuit-skips, then the final 502.

For a flapping upstream:

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"chaos-fail-rate-50","messages":[{"role":"user","content":"hi"}]}'
```

Some succeed, some fail — and `request_logs.retry_count` shows how often retries hid the failure from the client.

---

## Observability

### Logs

JSON via [pino](https://github.com/pinojs/pino). Every line is structured. Every line for one request carries the same `requestId`. Example useful jq queries while tailing:

```bash
pnpm dev 2>&1 | jq 'select(.msg=="Provider call failed; trying next candidate")'
pnpm dev 2>&1 | jq 'select(.requestId=="req_abc123")'
```

### Prometheus metrics

`GET /metrics` exposes:

- `llmgate_chat_requests_total{tenant,provider,model,status,streamed,cache}`
- `llmgate_chat_errors_total{provider,model,error_type}`
- `llmgate_request_latency_seconds` (histogram → derive p50/p95/p99)
- `llmgate_stream_ttfb_seconds`
- `llmgate_tokens_total{tenant,model,kind}` (kind = prompt | completion)
- `llmgate_cost_usd_total{tenant,model}`
- `llmgate_cache_operations_total{op}`
- `llmgate_circuit_open` (gauge)
- `llmgate_rate_limited_total{tenant,kind}`
- `llmgate_budget_exceeded_total{tenant,period}`
- Default Node.js metrics (event-loop lag, GC, memory, file descriptors).

### Per-tenant usage report

```bash
curl -H "Authorization: Bearer $KEY" \
  "http://localhost:4000/v1/usage?from=2026-05-01"
```

---

## Inspecting the database

```bash
pnpm --filter @llmgate/gateway db:studio
# opens https://local.drizzle.studio
```

Tables:

- `tenants` — id, name, status, created_at
- `api_keys` — id, tenant_id, prefix (visible), hash (sha256), label, revoked_at
- `tenant_config` — budget caps, rate limits, allowlists
- `request_logs` — id (== request_id), tenant_id, provider_id, requested_model, resolved_model, status, prompt/completion/total tokens, cost_usd, latency_ms, ttfb_ms, attempts, retry_count, streamed, cache_hit, error_message

---

## Layout

```
llmgate/
├── apps/gateway/                # the service
│   ├── drizzle/                 # SQL migrations
│   ├── scripts/seed.ts          # mints a tenant + API key
│   └── src/
│       ├── admin.ts             # /admin/* CRUD
│       ├── auth.ts              # bearer-token onRequest hook
│       ├── cache/               # CacheStore interface + memory impl
│       ├── config.ts            # env validation (Zod)
│       ├── db/                  # Drizzle schema, client, logger
│       ├── index.ts             # Fastify app, /v1 handlers
│       ├── limits/              # rate, budget, allowlist
│       ├── metrics.ts           # Prometheus meters
│       ├── providers/           # Provider interface + adapters
│       │   ├── chaos.ts         # failure injection
│       │   ├── gemini.ts
│       │   ├── groq.ts
│       │   └── openai-compatible.ts  # generic adapter (Groq, OpenRouter, vLLM, …)
│       ├── request-id.ts        # x-request-id middleware
│       ├── resilience/          # timeouts, retry, circuit breaker
│       └── routing/             # model registry + policy
├── docker-compose.yml
├── DESIGN.md
└── README.md
```

---

## Development

```bash
pnpm dev                                    # gateway in watch mode
pnpm --filter @llmgate/gateway db:generate  # generate a migration after schema change
pnpm --filter @llmgate/gateway db:migrate   # apply migrations explicitly (also runs at startup)
pnpm --filter @llmgate/gateway db:studio    # web UI to inspect data
pnpm --filter @llmgate/gateway db:seed      # mint a tenant + key
pnpm exec tsc --noEmit                      # typecheck
```

---

## Docker

A single-service `docker-compose.yml` is included for SQLite-on-a-volume deploys.

```bash
cp apps/gateway/.env.example apps/gateway/.env  # fill in keys
docker compose up --build
# gateway available at http://localhost:4000
```

For Postgres-backed production deploys, see DESIGN.md §3 ("Decisions and tradeoffs"). Drizzle is dialect-agnostic; the schema ports cleanly.

---

## What this is and isn't

**Is**: a working, multi-tenant gateway that you can put in front of an internal team or beta. Single process, single SQLite file, zero ops setup beyond a dotenv. Every functional requirement of the brief is implemented end-to-end.

**Isn't**: production-grade for an unbounded customer base. The honest gap analysis is in DESIGN.md §6.

License: MIT.
