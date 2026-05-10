# llmgate — Design Document

This document explains the gateway's job, how it's built, the trade-offs behind every meaningful decision, where it breaks under stress, what was deliberately punted on, and what the path to production looks like. The README covers how to run it; this document covers why it looks the way it does.

---

## 1. Problem framing

The gateway exists because the seam between application code and an LLM provider is the single highest-friction part of running an AI product. Without a gateway, every product team owns the same boilerplate: their own provider key juggling, their own retry policy with subtly different bugs, their own ad-hoc usage logging that nobody in finance trusts, their own per-customer rate limits invented during an incident at 3am.

**The gateway is the place where that boilerplate becomes infrastructure.** It owns:

- **Translation** — clients speak one HTTP shape (OpenAI's). Behind the gateway, multiple providers with different shapes, naming conventions, error semantics, and streaming protocols. The gateway is the only place that knows about that mismatch.
- **Tenancy** — credentials, budgets, rate limits, allowlists, audit. A tenant means "the unit we bill, throttle, and cut off." Per-tenant policy lives in one place.
- **Decisions in the failure path** — what to do when a provider is slow, when it's down, when it's over rate-limit, when the request is flagged for safety, when the same request was just made one second ago.
- **The ledger** — every paid call has a row. Cost-per-tenant, cost-per-model, latency p95 — these become first-class facts you can query, not guesses you reconstruct from logs.

**The gateway is explicitly NOT:**

- An **agent runtime**. We don't manage tool execution loops, planning, or multi-turn state across requests. The client owns conversation state and the call graph.
- A **prompt library**. We don't store prompts, version them, or A/B them. Clients send full message arrays.
- A **vector database** or RAG layer. We don't do retrieval. If a client wants RAG, they retrieve their own context and put it in `messages`.
- A **safety classifier**. We surface upstream safety verdicts as `finish_reason: "content_filter"` but don't run our own moderation.
- An **identity provider**. API keys are coarse-grained per-tenant credentials. Per-end-user identity, ACLs, and SSO are the calling app's responsibility.
- A **billing system**. We compute cost-per-call as USD floats and persist them. Invoicing, taxes, currency conversion, dunning, and statements are downstream.

**Responsibility boundary.** The calling app sends a complete request and an API key. The gateway returns a complete response or a structured error. The gateway must never throw an unhandled exception across the boundary, must never leak another tenant's data, and must never charge a tenant whose budget is exhausted. Anything else — prompt construction, retries beyond what the gateway decided, conversation memory, end-user attribution — belongs to the calling app.

---

## 2. Architecture

### Shape

A single Node.js process running Fastify. SQLite sits on local disk via `better-sqlite3`. Drizzle is the ORM. Everything per-process: rate-limit counters, circuit-breaker state, response cache. The DB is the source of truth for everything that survives a restart (tenants, keys, config, request logs).

### Request flow

```
HTTP request
    │
    ▼
onRequest hooks, in order:
  applyRequestId  ──►  generates/forwards x-request-id
  applyAuth       ──►  hashes bearer, looks up tenant; 401 if invalid
  applyAdmin      ──►  X-Admin-Key gate for /admin/*
    │
    ▼
Route handler /v1/chat/completions
    │
    ▼
Zod body validate           → 400 on malformed
Rate limit (RPM)            → 429 + Retry-After
Rate limit pre-flight (TPM) → 429 + Retry-After
Budget check (sum logs)     → 402
Cache lookup (if temp=0)    → 200 fast path with cache_hit:true
Routing policy              → ordered candidate list
Allowlist filter            → 403 if all blocked
    │
    ▼
For each candidate:
  Circuit breaker tryAcquire   → skip if open
  Wrap call with timeout       → AbortSignal propagated to provider SDK
  Retry transient errors       → bounded jittered backoff
  recordSuccess / recordFailure on the circuit
  Continue or return
    │
    ▼
recordRequestLog → SQLite row + Prometheus counters
    │
    ▼
HTTP response
```

### Where state lives

| State | Where | Survives restart? | Shared across replicas? |
|---|---|---|---|
| Tenants, keys (hashed), config | `tenants`, `api_keys`, `tenant_config` in SQLite | yes | yes (single DB) |
| Per-request log | `request_logs` in SQLite | yes | yes |
| Response cache | In-process `Map` (`MemoryCacheStore`) | no | no |
| Rate-limit counters (RPM, TPM) | In-process `Map` | no | no |
| Circuit breaker state | In-process `Map` | no | no |
| Streaming chunks during a live stream | Stack frame of the request handler | n/a | n/a |

The pattern is: **durable facts in the database, hot ephemeral state in the process.** That's a deliberate choice, not an oversight (see §3, "Cache layer" and "State in-process").

### Failure domains

There are four:

1. **The request-handler process itself.** A bug, OOM, or hard panic kills it. The system's blast radius is "this replica's in-flight requests." Persistent state survives because it's in SQLite.
2. **The database.** SQLite means the database is "the local filesystem." If the disk fills or corrupts, all writes (auth lookups too) fail; the gateway returns 5xx until storage is restored. Postgres swap (described below) makes this an external dependency.
3. **An upstream provider.** Isolated by provider id and by `(provider, model)` for circuit breakers. Gemini being down cannot block Groq calls.
4. **A single tenant.** Isolated via per-tenant counters, budgets, and allowlists. One tenant flooding the gateway gets 429s and goes nowhere near another tenant's quota.

The single-process architecture means the *replica* is itself a failure domain — a per-replica restart loses warm caches and rate-limit counters. The database survives. We rebuild from telemetry on the next request.

### What gets harder at 10× traffic

- **The DB write per request becomes the bottleneck.** SQLite WAL handles low-thousands of QPS on a single SSD; past that we batch logs in process or move to Postgres.
- **The /v1/usage budget query** scans `request_logs` for the current day/month. With an index on `(tenant_id, created_at)` it's fast at low scale, but a tenant with millions of rows per month will see this become noticeable. The fix is a `usage_daily` rollup (in-process buffer flushed every 60s) — designed for, not implemented.
- **In-process rate-limit / circuit state** drifts the moment you run two replicas. Any tenant's effective rate doubles. Move state to Redis with sliding-window counters or a Lua-implemented token bucket.
- **The cache** is per-process, so the hit rate drops the moment you scale out. Move to Redis.

---

## 3. Key decisions and tradeoffs

### Wire format: OpenAI-compatible

**Considered:** OpenAI shape; Anthropic shape (`/v1/messages`); a vendor-neutral shape we invent ourselves; a SDK-only library. **Picked:** OpenAI shape (`/v1/chat/completions` + `/v1/models` + SSE streaming).

**Why:** the OpenAI shape is the de facto interchange format. The OpenAI npm SDK, the official OpenAI Python SDK, the Vercel AI SDK, LangChain, LiteLLM clients, and dozens of other tools all already speak it. By choosing OpenAI shape, **a customer adopts the gateway by changing one environment variable** (`OPENAI_BASE_URL`). Inventing our own shape would have forced every integration to be a custom rewrite.

**Trade-off:** the OpenAI shape leaks slightly into our types — for example, `finish_reason` is exactly OpenAI's enum. That's the cost of standardization. Writing an Anthropic-shape `/v1/messages` endpoint as a *second* surface is on the table; both shapes can translate to/from the same canonical request internally.

### Routing: cost-class with failover

**Considered:** latency-aware (pick whoever's currently fastest), sticky-tenant (same tenant always hits the same provider for cache locality), round-robin, model-class with cost ordering. **Picked:** model-class with cost ordering.

**Why:** the brief says "non-trivial" routing, and cost-class is the routing decision that has the highest leverage in real product work. It lets product teams write `model: "cheap"` and have the gateway pick the cheapest healthy candidate at the moment the call is made. Latency-aware sounds attractive but requires per-candidate latency telemetry maintained in real time, which is a separable problem; we collect the telemetry (TTFB histograms) so a future latency-aware policy is a one-file swap.

**Pluggability** is enforced by `resolveCandidates(requested) → RoutingCandidate[]`. The handler doesn't know what the policy is. Replacing the file in `routing/policy.ts` swaps the policy.

**Trade-off:** cost ordering is static (from the model registry's published prices). Real prices can change; we'd want a `cache_version`-style bump or a config-driven price table for that. We chose static for clarity.

### Datastore: SQLite (Drizzle)

**Considered:** SQLite + Drizzle; Postgres + Drizzle; Postgres + Prisma; a JSON file; a key-value store like LMDB. **Picked:** SQLite + Drizzle for the assignment with Postgres support designed-in.

**Why:** the brief explicitly allows SQLite. SQLite gives us a real relational database (joins, indexes, transactions, WAL) with **zero ops**. `better-sqlite3` is synchronous, which is actually a feature for an ORM — no `await` overhead per query, simpler control flow. Drizzle's schema is dialect-agnostic; the same `schema.ts` generates Postgres migrations after a one-line config change.

**Trade-off:** SQLite assumes one writer at a time. Multi-replica deployments need Postgres. We're explicit about that being a non-issue at single-replica and a real issue at scale (see §6).

### ORM choice: Drizzle over Prisma

**Considered:** Prisma, Drizzle, raw SQL via `better-sqlite3`. **Picked:** Drizzle.

**Why:** Drizzle has a SQL-first API with end-to-end TypeScript inference, no separate code-generation step (Prisma needs `prisma generate`), no separate runtime (Prisma ships its own query engine binary), and clean dialect portability. The runtime footprint is smaller and the mental model is closer to the SQL we're actually issuing — useful for the request-log aggregations.

**Trade-off:** Drizzle's ecosystem is younger than Prisma's. Migrations work well; relational query helpers are less ergonomic than Prisma's. We don't use those features here.

### Cache layer: in-process Map

**Considered:** Redis, in-process LRU, in-process Map with TTL, no cache. **Picked:** in-process Map with lazy TTL eviction, behind a `CacheStore` interface.

**Why:** the cache only has to be correct; performance is a side-effect. A Map with `Date.now()` checks at read time is the simplest possible thing that fully encapsulates expiration, and the interface guarantees a Redis swap is a one-file change. For development and single-replica deployments, this is exactly the right choice.

**Trade-off:** at multi-replica, hit rate drops because each replica has its own Map, and cache writes from replica A are invisible to replica B. The interface is the point; we lose hit rate, not correctness. The DESIGN.md "scaling story" §7 includes the fix.

### Sync vs async I/O for SQLite

**Considered:** `better-sqlite3` (synchronous), `@libsql/client` (async), `bun:sqlite`. **Picked:** `better-sqlite3`.

**Why:** Node's HTTP path is already async. The DB call is one CPU-bound disk-cached operation per request — synchronous-blocks for sub-millisecond windows under our load. Eating the syscall on the event loop is fine and avoids the Promise overhead of an async client. For Postgres we'd switch to an async driver (`pg` via Drizzle's postgres-js adapter), and that's where async pays off.

**Trade-off:** if a single SQLite query starts taking, say, 200ms, every concurrent request stalls. With WAL and the indexes we have, that doesn't happen at single-replica scale. When it does, that's the signal to move off SQLite.

### Queue or no queue

**Considered:** put a queue between the request and the upstream call (decouple, smooth bursts, durable retries). **Picked:** no queue. The gateway is request/response.

**Why:** the LLM gateway's value is *latency-bounded synchronous* request/response. Nobody waits 30 seconds for "your chat reply is ready in your inbox." A queue inverts that, and the failure modes (poison messages, replay storms, ordering surprises) cost more than they save at this layer. The ONE place a queue would help is the `request_logs` insert — making it async-batched would absorb DB write spikes — but `better-sqlite3` makes the synchronous insert fast enough that it's not currently a bottleneck.

### Resilience: retry inside circuit + failover across candidates

**Considered:** retry-only, circuit-only, both. Considered also: hedging (fire two requests in parallel, take the first). **Picked:** retry within candidate + circuit-breaker per `(provider, model)` + failover across candidates.

**Why:** retry is for *transient* errors on the same upstream (TCP reset, brief 5xx, rate-limit blip). Failover is for *sustained* errors on a specific upstream (provider down, key revoked, model deprecated). Both layers compose naturally: retry first, fail to circuit, then move to the next candidate. The circuit breaker keeps a sustained outage from costing us latency on every request — once it's open, we skip without trying.

**Hedging** would reduce p95 latency at the cost of doubling provider spend on every request. For a cost-conscious gateway this trade-off is wrong. Selective hedging on cheap-tier models is a future enhancement.

### Streaming token accounting

We extract token usage from the **last chunk** of the stream — Gemini emits `usageMetadata` on its final chunk, and we ask OpenAI-compatible providers to include usage via `stream_options: { include_usage: true }`. This means streamed responses get billed correctly, same as non-streaming.

**Trade-off:** the chunk shape grows an optional `usage` field that's non-OpenAI-standard but matches OpenAI's recent extension. Worth it.

### Secrets handling

Provider API keys are read from environment variables, validated by Zod at startup, and loaded once into the in-process clients. They never enter the database, never enter logs, never leave the process.

**Considered:** BYOK — letting tenants store their own provider keys, encrypted at rest in `provider_credentials` with AES-256-GCM. **Decision:** designed but not implemented. The schema and encryption strategy are sketched (see §5).

### Language and framework

**Considered:** Node + Fastify, Node + Express, Node + Hono (edge-friendly), Bun + Hono, Go + chi. **Picked:** Node 24 + Fastify + TypeScript-strict.

**Why:** Fastify has the cleanest plugin/hook model for the request-lifecycle work the gateway does (auth, request-id, admin gate). Node's ecosystem has first-party SDKs for every major LLM provider. TypeScript-strict catches the multi-shape translation bugs that are easy to introduce when adding providers. Bun would shave milliseconds; Go would give us a smaller container — neither matters at this scale.

### Deployment model

**Considered:** serverless function, container on a VM, edge runtime, Kubernetes. **Picked:** Docker container, single replica, persistent volume for SQLite. Documented in `Dockerfile` and `docker-compose.yml`.

Serverless is a poor fit because: the gateway holds streaming connections for many seconds, has long-lived in-process state (cache, rate limits, circuit), and benefits from connection pooling to upstreams. A container behind a TCP load balancer scales horizontally once we move the in-process state to Redis (next step).

---

## 4. Failure modes

### Anthropic (or any upstream) is slow but not failing

- The per-call timeout (`PROVIDER_TIMEOUT_MS`, default 60s) bounds the wait. The Provider SDK gets an `AbortSignal`; an aborted request raises, and the retry layer treats it as transient.
- Retry kicks in once with backoff. If the timeout fires twice in a row, the candidate is marked failed.
- The circuit accumulates failures. After five within 30 seconds, future calls to that `(provider, model)` skip immediately for 30s, then half-open to probe.
- During the slow period, **other candidates serve the request** because failover walks the list. The client sees `x-llmgate-attempts` > 1 but a successful response with normal latency.
- TTFB histogram in `/metrics` shows the slow tail; structured logs annotate each retry with `requestId` so a single Anthropic incident is one query in any log tool.

### A provider returns garbage that's structurally invalid (e.g., empty response)

- Adapters defensively coerce missing fields to safe defaults (`response.text ?? ""`, `usage.prompt_tokens ?? 0`). The handler never sees `undefined`.
- If the *stream* yields no chunks at all, `probeStream` returns `{ error: "stream ended with no chunks" }` and we failover.
- If the stream's first chunk arrives but later chunks throw, we send a synthetic terminator chunk with `finish_reason: "upstream_disconnect"` and end the SSE cleanly. The client sees a complete-looking stream with a clear final reason.

### DB is partitioned from the app server

This depends on which DB:

- **SQLite (current setup):** the DB is local disk. If disk fails, every write fails — auth (read), budget check (read), log insert (write). The server returns 5xx for everything. Recovery: restart on healthy storage, replay any in-flight writes from logs (none, since we don't queue).
- **Postgres (future):** the gateway's auth/budget queries are dependencies of the request path. A network partition produces 5xx until reconnect. The connection pool retries. Worst case, `request_logs` writes fail silently — we log a warning. Lost log rows mean lost spend tracking; fix is a small in-process write-ahead buffer flushed best-effort.

The auth layer has no fallback by design. Allowing requests through during a DB outage is a tenancy violation.

### A tenant sends a 200KB prompt

- Fastify enforces a body-size cap (configurable; default 1MB). 200KB passes.
- Zod validation accepts it (no `max` constraint on `messages[].content`).
- The provider SDK either accepts it (if within context window) or returns an error. 4xx errors are not retried (`isTransient` filters by status).
- TPM rate limiter sees the inflated prompt-token count *after* the call completes (we don't tokenize ahead). A tenant with TPM=10000 and a 200KB prompt that consumes 50K tokens will get rejected on their *next* request, not this one.
- **Trade-off**: pre-flight tokenization would prevent surprise overruns but adds a slow CPU step per request and ties us to provider tokenizers. The chosen "best-effort post-flight TPM" is a deliberate compromise.

### Two tenants race the same cache key

They can't. Cache keys are prefixed with `chat:<tenantId>:<hash>` — each tenant has their own keyspace. Cross-tenant cache sharing was not in scope and would be a privacy hazard for chat completions.

### Circuit breaker thundering herd on half-open

When the circuit transitions to half-open, only **one** request gets through (`halfOpenInFlight` is a flag). The rest see `circuit_open` and fall through to other candidates. If the probe succeeds, the circuit closes and traffic resumes. If it fails, the circuit opens again. No herd.

### Mid-stream client disconnect

The handler doesn't currently track `request.raw.on('close')` — if the client hangs up, the AsyncIterable continues consuming upstream tokens until it finishes, then we silently end. The cost is wasted upstream tokens for the rest of the response. The fix is one event listener that aborts the stream's AbortController; documented as a punt below.

### A bad migration

Migrations run at server startup via Drizzle. A bad migration means the server never starts, which is loud and obvious. Database isn't half-migrated because Drizzle wraps each migration in a transaction. Recovery is to revert the migration file, restart, and re-generate.

### Budget cap not respected

Budget is checked *before* the call. The cap is the spend at the **start** of the request. A request that *crosses* the cap mid-call still completes and gets billed; the **next** request is rejected. This is intentional — refusing requests because their cost might exceed the cap requires pre-flight cost estimation, which requires tokenization, which is the trade-off above. Tenants over-spend by at most one in-flight request.

### Two requests arrive simultaneously, both within budget but their sum exceeds it

Both succeed. Same reason as above — we check before, not after. The next call is the one rejected. For a hard cap with no overshoot, you need a Lua-implemented atomic decrement in Redis. That's the Production-grade follow-up.

### `ADMIN_API_KEY` is leaked

All admin endpoints become vulnerable: tenant creation, key creation, config updates. The key has no scoped permissions. Mitigations on production: rotate via env, deploy admin separately on an internal-only port, require mTLS. We log every admin action; rotation isolates blast radius to the time-window between leak and rotation.

---

## 5. What I didn't build

Concrete list of what's missing or simplified, in roughly descending importance:

1. **BYOK provider credentials per tenant.** Schema sketched (`provider_credentials` with AES-256-GCM encryption, master key from env, per-record IV, key versioning via `kid`), but not implemented. Currently tenants share the gateway operator's API keys. For a true "bring your own keys" product this is the next 2–3 days of work.
2. **Postgres dialect.** Schema is portable, code is portable, only Drizzle config and the migration set differ. Probably 1 day including testing the dialect-specific behaviors (e.g., `$inferSelect` types, JSON column handling).
3. **Streaming client-disconnect propagation.** Listen on `request.raw.on('close')`, abort the upstream signal, finalize log row with partial token count. ~1 hour.
4. **Per-tenant cache namespaces with manual flush.** The infra is there (`cache.clear(prefix)`), the admin endpoint isn't. ~1 hour.
5. **Pre-flight token estimation for budget and TPM.** Wire `tiktoken` (OpenAI), `@anthropic-ai/tokenizer`, and per-provider tokenizers. ~half a day plus a per-provider table mapping model → tokenizer.
6. **Distributed rate limit / circuit / cache.** Redis-backed. With `ioredis`, the changes are: `RedisCacheStore` (already designed for, ~1 hour), token-bucket rate limiter via Lua (~half a day), shared circuit breaker (~half a day).
7. **OpenTelemetry traces.** Currently we emit Prometheus metrics and structured logs with `requestId`. Adding W3C tracing spans would make incident debugging across multiple services trivial. Roughly 1 day with the OTel SDK.
8. **Anthropic adapter.** Trivial given the Provider interface; we have Gemini + Groq covering the brief's "at least two." ~2 hours.
9. **Web admin dashboard.** Drizzle Studio is the current admin UI. A small Next.js or Remix dashboard would be tenant-friendly. 2–3 days minimum.
10. **A redaction layer in logs.** Currently we log enough to debug but never the prompt body. A more robust system would have an explicit `request.body.prompt` redaction policy.

**What I'd redesign if I started over.**

- I'd put `request_id` and `tenant_id` into Fastify's context-from-the-start rather than threading them through every function signature. The boilerplate of `request.tenant!.id` could be a `getContext()` helper backed by `AsyncLocalStorage`.
- I'd set up the Redis-backed primitives from day one with a dev-mode in-memory shim. Building first in-memory and then having to swap is more work than starting with the abstraction.
- I'd put adapters in a workspace package (`packages/providers`) rather than `apps/gateway/src/providers`, so they could be unit-tested without spinning up Fastify.
- I'd make the provider call a small state machine — `attempt → timeout → retry? → circuit?` — instead of nested try/catch with shared variables.

---

## 6. Production gap analysis

The brief asks for top 5 gaps and rough cost estimates to close them.

### 1. State distribution (rate limits, circuit, cache) — 3 days

**Today:** in-process Maps. **Issue:** the moment we run two replicas, every tenant's effective RPM doubles, and a circuit opening on replica A is invisible to replica B. This is the single biggest scale blocker. **Plan:** introduce `ioredis`, write a `RedisCacheStore` against the existing `CacheStore` interface (no handler changes), implement rate limits as a Lua-evaluated token bucket (atomicity matters), implement circuit breaker as a hash of state with TTL. Keep the in-memory implementation for local dev and tests behind a `CACHE_BACKEND=memory|redis` switch. **Effort:** 3 days including load testing the new primitives.

### 2. Postgres + multi-replica — 4 days

**Today:** SQLite, single writer, single replica. **Issue:** can't run more than one gateway process; can't survive a host failure without losing in-flight state and warm caches. **Plan:** swap Drizzle dialect to Postgres (`drizzle-orm/postgres-js`); regenerate migrations; introduce a connection pool config; add a `pg_stat_statements`-friendly index review; deploy behind a TCP load balancer with sticky sessions disabled (with shared state, no need for them); add a graceful-shutdown hook that drains in-flight requests. **Effort:** 4 days including a stress test of one replica vs three.

### 3. Secrets management and BYOK — 3 days

**Today:** keys in `.env`, hashed API keys in DB, no per-tenant provider credentials. **Issue:** for a real multi-tenant product, tenants want their *own* provider relationship with the upstream. Operationally, the gateway shouldn't carry every customer's key in a single env file. **Plan:** integrate a secret store (AWS Secrets Manager, GCP Secret Manager, or HashiCorp Vault) for the gateway's master encryption key; add `provider_credentials` table with AES-256-GCM-encrypted secrets, `kid`-versioned for rotation; admin API to add/rotate per-tenant credentials; provider adapters select tenant credential at call time. **Effort:** 3 days for the full path including a key-rotation runbook.

### 4. SLO observability + alerting — 2 days

**Today:** Prometheus metrics on `/metrics` and structured logs; a human can read them. **Issue:** there's no on-call runbook, no SLOs, no alerts. **Plan:** ship a Grafana dashboard JSON with: request rate by tenant, error rate by provider, latency p50/p95/p99 by route, budget exhaustion alerts, circuit-state heatmap. Define SLOs (e.g., 99.5% of `/v1/chat/completions` calls succeed; p95 < 5s for non-streaming). Wire Alertmanager rules: page on circuit-open > 5 min, error rate > 1% for 5 min, p95 latency > 3× baseline. Write a one-page runbook covering: provider-down, DB-down, secret rotation, evicted cache. **Effort:** 2 days.

### 5. Load testing + chaos drills — 2 days

**Today:** the chaos provider lets reviewers inject failures by hand. There's no automated load test. **Issue:** before production, you find scaling cliffs in load test, not in incidents. **Plan:** a `k6` script that ramps up to N concurrent tenants with realistic prompt sizes and request patterns, plus a chaos schedule (random `ENABLE_CHAOS=true` blips, random Postgres restarts, random Redis evictions). Run the suite weekly in CI with regression alerts on tail latency. **Effort:** 2 days for the script + initial baseline.

**Other gaps worth naming:** mTLS between gateway and admin clients, structured rate-limiting per IP (not just per-tenant) to avoid credential-stuffing, prompt-size enforcement before tokenization, automatic database backups, log retention policy with PII purge, pre-deploy migration dry-run, and CI test coverage. Each is one to a few days but not blocking the first deploy.

---

## 7. Scaling story

### 10 RPS

This is the single-replica happy path. Today's setup handles it sitting down.

- SQLite with WAL handles ~5,000 inserts/sec on commodity hardware. We do one insert per request (the log row). At 10 RPS we're at 0.2% of that ceiling.
- Gemini and Groq both rate-limit at the *upstream* level. At 10 RPS we're bumping into Gemini's 60 RPM free tier, not anything in our code.
- The hot DB query (budget sum) runs once per request and hits the `(tenant_id, created_at)` index — sub-millisecond at this scale.

**What breaks first:** nothing. The gateway is overspecified for this load.

### 1,000 RPS

Now things get interesting. With our default `PROVIDER_TIMEOUT_MS=60000` and an upstream p95 around a second, we'll have hundreds of in-flight provider calls at any moment. Several pressures appear in roughly this order:

- **The request-log insert.** 1000 SQLite inserts/sec is fine in isolation, but each one acquires the WAL writer lock briefly. Under hot contention with reads (auth lookups, budget sums), lock convoy effects dominate. **Fix:** batch log inserts with a 100ms in-process buffer flushed by a setInterval, accepting up to 100ms of log loss on hard crash. Or move to Postgres.
- **The budget sum query.** At 1000 RPS this runs 1000 times/sec. Even with the index, scanning a tenant's month of logs gets slow if the tenant has, say, 20M rows. **Fix:** materialize a `usage_daily` rollup, updated by a side-effect of `recordRequestLog`. Budget query becomes "sum the rollup since start-of-month" — bounded by 31 rows.
- **The single Node.js event loop.** Node is single-threaded for JavaScript execution. At 1000 RPS even small synchronous overhead (Zod validate, JSON.stringify of large bodies, SQLite query) adds up. **Fix:** profile, but mostly run **multiple replicas** — 4× t3.medium or equivalent, each at 250 RPS. That requires the state distribution of §6 gap #1.
- **Outbound connection limits to providers.** Each provider SDK manages an HTTP/2 client; with default-tier accounts, you'll hit upstream rate limits long before exhausting connection slots. **Fix:** higher-tier API plans plus internal queueing; we'd add a per-provider concurrency cap with a small bounded queue.

**At 1,000 RPS we are running 3–4 replicas behind an L4 load balancer, with Redis backing rate-limit/circuit/cache, and Postgres backing audit + tenant data.** This is the "production-grade" deployment described in §6.

### 100,000 RPS

This is where the design has to actually change, not just scale.

- **You can no longer hit a single Postgres instance for every auth lookup, every budget check, every log write.** The auth lookup is a bearer-key hash lookup; we'd cache it in Redis with a short TTL plus a pub/sub invalidation channel for revocations. Budget checks would read from per-tenant rollups maintained in Redis, written through to Postgres asynchronously. Log writes would go through a Kafka/Pulsar topic or an in-process buffer that flushes to a logs-only Postgres or to ClickHouse/BigQuery for analytics.
- **Routing decisions become latency-sensitive.** At 100k RPS a stale "this provider is healthy" decision can mean dropping millions of requests. Circuit state must be sub-millisecond freshness — Redis pub/sub for state changes, with each replica subscribing.
- **The cache becomes a meaningful cost saver.** Cache hit-rate at this scale needs to be tuned. We'd add cache warming (popular prompts pre-computed), per-prompt-class TTL, and a CDN-style fan-out for the most-popular keys.
- **Streaming becomes the dominant latency budget.** TTFB matters more than total latency because the user is watching tokens appear. We'd add per-region replicas and route to the nearest one; multiple regional load balancers with geo-DNS.
- **You have to think hard about HTTP/2 vs HTTP/3 to upstream providers.** Connection pooling and request multiplexing dominate.
- **Observability cardinality explodes.** Tagging metrics by `tenant` is fine at 1,000 tenants but gets expensive at 1M. We'd move tenant-level metrics to log aggregation (ClickHouse) and keep Prometheus for service-level shape only.
- **One process per CPU is no longer enough.** Even with state distribution, you want many small replicas so a bad deploy or memory leak blast-radius is small. 100s of replicas across a few regions, autoscaled on request rate and tail latency.

**The first real cliff at 100k RPS is database write throughput**, then **upstream provider rate limits**, then **per-replica connection limits**. Each is well-known territory; none requires re-architecting the gateway itself, only the surrounding infrastructure.

---

This document is meant to be read once and used as a reference when something is unexpected. The README is enough to run it; this is enough to debate it.
