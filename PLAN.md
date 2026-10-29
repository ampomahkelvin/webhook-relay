# Webhook Delivery Service

Build plan, requirements, and delivery checklist. See `DESIGN.md` for the reasoning behind each decision.

**Stack:** TypeScript (strict), Node.js 22, Express, PostgreSQL 17, `pg`, `undici`, Zod, `pino`, `prom-client`, Vitest, Testcontainers, Docker Compose, Prometheus, Grafana, k6.

**Timeline:** about 3 to 4 weekends. Phases 0 to 3 take roughly one and a half, phases 4 to 6 one and a half, phases 7 to 10 one.

**Scope guard:** no CI, no UI, no deployment required. Done means tests pass locally, `docker compose up` runs the whole demo, and the README shows measured results. A live deployment is optional.

**Safety net:** tag `v1.0-core` at the end of phase 6 (intake, signed delivery, retries, breaker). Everything after that is hardening and polish.

---

## 1. Requirements

### Functional

**Tenancy and auth**
- FR1: An admin creates tenants through `POST /admin/tenants` (admin key), which also returns the tenant's first API key.
- FR2: Tenants authenticate with `Authorization: Bearer <api key>`. Keys are stored as SHA-256 hashes and can be revoked.
- FR3: Every resource is scoped to its tenant; another tenant's resource returns `404`.

**Endpoints**
- FR4: Create, list, get, update, and delete endpoints. Each has a URL, a description, and event types (`*` or exact names).
- FR5: The signing secret (`whsec_...`) is returned once, at creation.
- FR6: A tenant can have at most `MAX_ENDPOINTS_PER_TENANT` endpoints (default 20).
- FR7: Endpoints can be enabled or disabled. Disabled endpoints receive no new deliveries.
- FR8: `POST /v1/endpoints/:id/test` sends a `webhook.test` event to that endpoint only.

**Event intake**
- FR9: `POST /v1/events` requires `Idempotency-Key`; body is `{ eventType, payload }` with an object payload of at most 256 KB.
- FR10: The event and one delivery per matching enabled endpoint are created in one transaction. Success returns `202` with `{ id, deliveries }`.
- FR11: Same key and same request returns the original result with `Idempotent-Replayed: true`. Same key with a different request returns `422`.
- FR12: Concurrent duplicate submissions result in exactly one event.

**Delivery**
- FR13: Deliveries are sent as signed `POST` requests with `Webhook-Id`, `Webhook-Timestamp`, and `Webhook-Signature` (Standard Webhooks style).
- FR14: `2xx` is success. Other outcomes are retried on the schedule (about 8 attempts over about 28 hours) with ±20% jitter, then marked `dead`.
- FR15: `Retry-After` on `429` and `503` is honored (capped at 1 hour).
- FR16: `410` marks the delivery dead and disables the endpoint.
- FR17: Redirects are never followed. Response bodies are read to at most 64 KB; 1 KB is stored.
- FR18: Every attempt is recorded (status code, duration, error kind, response snippet).

**Resilience**
- FR19: Per-endpoint circuit breaker (closed, open, half-open) driven by consecutive failures.
- FR20: One endpoint's backlog or slowness never prevents other endpoints from being served (per-endpoint claim cap).
- FR21: Pending deliveries older than `DELIVERY_MAX_AGE` are marked `dead` by the expiry sweep.
- FR22: Endpoints failing continuously for `AUTO_DISABLE_AFTER` are disabled automatically.

**Operations**
- FR23: `GET /v1/deliveries` (filters: endpoint, status, event) and `GET /v1/deliveries/:id` (with attempt log).
- FR24: `POST /v1/deliveries/:id/replay` restarts the retry cycle for a `dead` or `succeeded` delivery.
- FR25: Events, deliveries, and attempts are pruned after `RETENTION_DAYS` (default 30).

### Non-functional

- NFR1: No database transaction is held open during an HTTP call to a receiver.
- NFR2: Dispatchers are safe to run in parallel: concurrent claims are disjoint, and a stale worker cannot overwrite newer delivery state (fencing).
- NFR3: A dispatcher crash at any point leaves the delivery recoverable (lease expiry).
- NFR4: The SSRF protections in `DESIGN.md` section 8 apply to every outbound request.
- NFR5: The dispatcher claims again immediately after a full batch and only sleeps when work runs out.
- NFR6: Secrets, API keys, and payloads never appear in logs.
- NFR7: `docker compose up` starts everything (Postgres, api, dispatcher, maintenance, sample receiver, Prometheus, Grafana) and runs migrations, with no extra steps.
- NFR8: Graceful shutdown: stop claiming, finish in-flight sends (up to a limit), exit.

### Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | | Postgres connection |
| `ENCRYPTION_KEY` | | 32 bytes, base64; encrypts signing secrets |
| `ADMIN_API_KEY` | | Admin API access |
| `MAX_ENDPOINTS_PER_TENANT` | 20 | Fan-out bound |
| `DISPATCHER_CONCURRENCY` | 50 | Parallel sends per dispatcher |
| `CLAIM_BATCH_SIZE` | 100 | Max deliveries per claim |
| `PER_ENDPOINT_CLAIM_CAP` | 10 | Fairness cap per endpoint |
| `POLL_INTERVAL_MS` | 500 | Sleep when idle |
| `LEASE_SECONDS` | 60 | Lease length |
| `REQUEST_TIMEOUT_MS` | 10000 | Total send timeout |
| `BREAKER_THRESHOLD` / `BREAKER_COOLDOWN_SECONDS` | 5 / 60 | Circuit breaker |
| `DELIVERY_MAX_AGE_HOURS` | 72 | Expiry sweep |
| `AUTO_DISABLE_AFTER_DAYS` | 5 | Failing endpoints |
| `RETENTION_DAYS` | 30 | Pruning |
| `ALLOW_INSECURE_HTTP` | false | Allow `http://` receivers (dev only) |
| `ALLOW_PRIVATE_TARGETS` | false | Disable the SSRF IP check (dev only) |

---

## 2. Suggested folder structure

```
.
├── docker-compose.yml
├── Dockerfile
├── README.md
├── DESIGN.md
├── PLAN.md
├── migrations/                 # SQL migrations
├── grafana/                    # provisioning + dashboard JSON
├── prometheus.yml
├── k6/
├── examples/
│   ├── receiver/               # sample receiver (verifies signatures, can misbehave)
│   └── ledger-bridge/          # optional: wallet.events → POST /v1/events
├── src/
│   ├── api/                    # routes, auth, validation, error handler
│   ├── dispatcher/             # claim loop, sender, result classifier
│   ├── maintenance/            # retention, expiry sweep, auto-disable
│   ├── domain/                 # signing, retry schedule, breaker rules, event-type matching
│   ├── security/               # SSRF-safe client, IP blocklist, crypto helpers
│   ├── db/                     # pool, transaction helper, queries
│   ├── metrics/
│   └── config/
└── test/
    ├── unit/
    ├── integration/            # real Postgres via Testcontainers
    ├── concurrency/
    ├── security/               # SSRF matrix, tenant isolation
    └── e2e/                    # compose-level or full-process tests
```

Keep `domain/` free of I/O. Signing, schedule computation, breaker transitions, event-type matching, and IP classification are pure functions that are easy to test exhaustively.

---

## 3. Build phases

Each phase ends with its tests passing and a commit. Keep commits small; the history is part of the portfolio.

### Phase 0: Scaffold
- [ ] TypeScript strict mode, ESLint, Prettier, Vitest
- [ ] Config module with Zod-validated environment
- [ ] `pino` logger with request ID
- [ ] Migration tool (`node-pg-migrate` or plain SQL files) and the initial migration from `DESIGN.md` section 4
- [ ] Testcontainers helper that gives each test file a fresh database
- [ ] Docker Compose: Postgres, api (`/health` only)

**Done when:** `docker compose up` starts the API and `/health` returns OK; `npm test` runs one database test.

### Phase 1: Tenancy and auth
- [ ] `POST /admin/tenants` with admin key
- [ ] API key generation, SHA-256 hashing, bearer auth middleware, revocation
- [ ] Global error handler and error shape
- [ ] Tests: valid, invalid, and revoked keys; admin endpoint rejects tenant keys

### Phase 2: Endpoint management
- [ ] Secret generation (`whsec_`), AES-256-GCM encryption helpers
- [ ] Endpoint CRUD with Zod validation, cursor pagination, endpoint cap
- [ ] Static URL validation (layer 1 of the SSRF defense)
- [ ] Tests: secret shown once; ciphertext differs from plaintext and decrypts back; tenant isolation (`404`); cap enforced

### Phase 3: Event intake and fan-out
- [ ] `POST /v1/events` with the single-statement transaction from `DESIGN.md` section 5
- [ ] Request hashing (canonicalized JSON), replay path, `422` on mismatch
- [ ] Per-tenant intake rate limit (in-memory token bucket)
- [ ] `GET /v1/events/:id`
- [ ] Tests: one delivery per matching enabled endpoint; wildcard and exact matching; disabled endpoints skipped; replay returns the same result; 50 parallel same-key submissions produce one event; a fault injected after the event insert leaves nothing behind

### Phase 4: Signing and the SSRF-safe client
- [ ] Pure signer with Standard Webhooks test vectors
- [ ] IP classifier (IPv4, IPv6, mapped, NAT64) with an exhaustive table test
- [ ] HTTP client: custom resolution, connect to the validated IP, SNI and Host preserved, no redirects, size and time limits
- [ ] Result classifier (status code or error kind to outcome)
- [ ] `examples/receiver` with signature verification and misbehavior switches
- [ ] Tests: signature vectors; every blocked range; URL tricks (decimal and octal IPs, userinfo, IPv6 zones); a **fake resolver that answers public first and private second** proves rebinding is blocked; redirect not followed; large response truncated

**Done when:** one hand-made delivery reaches the sample receiver, which verifies it.

### Phase 5: Dispatcher, leases, and retries
- [ ] Claim query (leases, `SKIP LOCKED`, per-endpoint cap), tuned with the concurrency tests
- [ ] Sender loop with bounded concurrency and the "claim again immediately after a full batch" rule
- [ ] Result recording with fencing (`attempt_count`)
- [ ] Retry schedule with jitter, `Retry-After`, `dead` after the last attempt
- [ ] Attempt log rows
- [ ] Graceful shutdown
- [ ] Tests:
  - Two dispatchers over 1,000 deliveries never claim the same delivery concurrently
  - A dispatcher killed mid-send: the delivery is retried after the lease expires
  - A stale worker (lease expired, another claimed) cannot change the delivery
  - Schedule table test (attempt index to delay range, with jitter bounds)
  - `Retry-After` pushes the next attempt out
  - After the last attempt the delivery is `dead`
  - A full batch triggers an immediate re-claim (no sleep)

### Phase 6: Circuit breaker, fairness, and endpoint health
- [ ] Breaker transitions as pure functions, applied with the write-amplification rule
- [ ] Half-open probe claim
- [ ] `410` handling (delivery dead, endpoint disabled)
- [ ] Per-endpoint claim cap verified under load
- [ ] Tests: breaker opens after N failures, probes after the cooldown, closes on success; a hung endpoint with 500 queued deliveries does not delay another endpoint's deliveries; healthy endpoints cause no endpoint-row writes

**Milestone:** tag `v1.0-core`.

### Phase 7: Operations API
- [ ] `GET /v1/deliveries` with filters and cursors, `GET /v1/deliveries/:id` with attempts
- [ ] `POST /v1/deliveries/:id/replay` (resets `cycle_start`, `next_attempt_at`)
- [ ] `POST /v1/endpoints/:id/test`
- [ ] Tests: replay of a dead delivery succeeds once the receiver recovers; attempt numbers stay unique across a replay; tenant isolation on every route

### Phase 8: Maintenance and observability
- [ ] Maintenance process with an advisory lock: retention pruning, expiry sweep, auto-disable
- [ ] `/metrics` on all three processes; gauges for pending count, oldest due age, open breakers
- [ ] Prometheus config and Grafana provisioning, with a dashboard (intake rate, outcomes, latency, backlog, delivery lag, open breakers)
- [ ] `/health/deep` (delivery lag, unsafe-flag warnings)
- [ ] Tests: retention cascades; expiry sweep kills stale pending deliveries; auto-disable fires; the lag gauge reports a deliberately delayed delivery

### Phase 9: Hardening and experiments
- [ ] Full SSRF test matrix run against the real client in a container network
- [ ] Tenant isolation test across all routes
- [ ] Log hygiene test: a captured log stream during a full flow contains no secret, API key, or payload
- [ ] Mutation experiments (section 5), recorded in `DESIGN.md`
- [ ] k6: intake throughput; delivery throughput against a fast receiver; behavior with a share of slow receivers

### Phase 10: Docs and demo
- [ ] README: pitch, architecture diagram, one-command start, `curl` walkthrough, sample receiver, known limitations
- [ ] `examples/ledger-bridge` (optional)
- [ ] Measured results in the README, with environment and commit
- [ ] Demo script (section 6), plus a short GIF or recording
- [ ] Final pass on `DESIGN.md` so it matches the code

---

## 4. Testing matrix

| Layer | What it proves |
|---|---|
| Unit (pure `domain/`, `security/`) | Signature vectors, schedule and jitter bounds, breaker transitions, event-type matching, IP classification |
| Integration (real Postgres) | Intake transaction, fan-out, replay, `422`, fencing, retention cascades |
| Concurrency | Disjoint claims, one event per key under parallel submission, no cross-endpoint starvation |
| Failure injection | Rollback on intake failure, dispatcher kill mid-send, stale worker |
| Security | SSRF matrix, DNS rebinding, redirect refusal, tenant isolation, log hygiene |
| End to end | Compose stack: submit an event, a signed request arrives, the receiver verifies it; break the receiver and watch retries and the breaker |
| Load (k6) | Measured intake and delivery throughput and delivery lag |

Use a real Postgres for every test that touches claims or transactions. Never mock the database for the concurrency tests; the locking behavior is the thing being tested.

---

## 5. Mutation experiments (prove the tests can fail)

Each mutation is made temporarily, the targeted test is run, the failure is recorded, and the change is reverted. Write the results into `DESIGN.md`, including any mutation that does **not** fail a test (that is a finding).

| Mutation | Test that should fail |
|---|---|
| Remove `SKIP LOCKED` and the lease re-check from the claim | Two-dispatcher disjoint-claims test |
| Remove the `attempt_count` fencing condition from the result update | Stale-worker test |
| Validate the URL's IP, then let the client resolve again (no pinned IP) | DNS rebinding test |
| Follow redirects | Redirect-refusal test |
| Drop the `UNIQUE (tenant_id, idempotency_key)` constraint | 50-parallel same-key test |
| Ignore `Retry-After` | Retry-After test |
| Sign without the timestamp | Signature vector test |
| Sleep after every batch, even a full one | Immediate re-claim test (and throughput) |
| Remove the per-endpoint claim cap | Fairness test |

---

## 6. Demo script

1. `docker compose up`; open Grafana (dashboard `Webhook Service`).
2. Create a tenant (admin key) and register the sample receiver as an endpoint; keep the secret.
3. Submit an event; show the signed request arriving and being verified by the receiver.
4. Submit the same event with the same `Idempotency-Key`; show `Idempotent-Replayed: true` and no second delivery.
5. Switch the receiver to `failRate=1`; submit events; show retries in the attempt log, the breaker opening, and delivery lag rising in Grafana.
6. Switch the receiver back to healthy; show the breaker closing and the backlog draining.
7. Register an endpoint pointing at `http://169.254.169.254/`; show it rejected (or, with a hostname that resolves to a private IP, the attempt recorded as `blocked_address`).
8. Kill the dispatcher during a burst (`docker compose kill dispatcher`), restart it, and show that every delivery still reaches the receiver (duplicates possible, none lost).

---

## 7. Definition of done

- [ ] `npm test` passes locally, including concurrency, failure-injection, and security suites
- [ ] `docker compose up` runs the full demo with no extra steps
- [ ] README with an architecture diagram, `curl` walkthrough, and known limitations
- [ ] `DESIGN.md` matches the code, including the mutation experiment results
- [ ] OpenAPI spec (hand-written is fine) covering every route
- [ ] Grafana dashboard provisioned from files
- [ ] k6 script and measured results committed
- [ ] Sample receiver that verifies signatures
- [ ] Demo GIF or recording

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The claim query is subtle (window function, `SKIP LOCKED`, leases) | Write the concurrency test first; simplify (drop the per-endpoint cap) and add it back only once the basic claim passes |
| SSRF handling is easy to get subtly wrong | Pure IP classifier with an exhaustive table test; one resolution only; test with a fake resolver |
| Scope creep (UI, ordering, rotation) | They are listed as stretch goals in `DESIGN.md`; none of them blocks `v1.0-core` |
| Timing-dependent tests are flaky | Inject a clock into the schedule and breaker logic; use short leases and delays in tests; avoid real sleeps where possible |
| Dispatcher throughput limited by one process | Measure first; scale by running more dispatcher instances, which the lease design already allows |
| Plain `http://` receivers in the demo conflict with the SSRF rules | Use the explicit dev flags, make them loud, and show `/health/deep` reporting them |

---

## 9. Resume bullets (fill in real numbers)

> **Webhook Delivery Service** | TypeScript, Node.js, PostgreSQL, Docker, Prometheus, Grafana
> - Built a multi-tenant webhook delivery service where events fan out to subscribed endpoints in a single Postgres transaction and are delivered at-least-once with HMAC-signed requests, jittered retry schedules, and per-endpoint circuit breakers
> - Designed Postgres as a durable queue using leases, `FOR UPDATE SKIP LOCKED`, and fencing tokens so parallel dispatchers never double-claim and a stale worker cannot overwrite newer state; verified with concurrency and kill-mid-send tests, sustaining **[N]** deliveries/s
> - Defended against SSRF and DNS rebinding by resolving once and connecting to the validated IP, with IPv4/IPv6 range blocking and no redirects; validated with a **[N]**-case test matrix and mutation experiments showing each control's test fails when the control is removed

---

## 10. Defaults I assumed (change any before building)

1. One-level tenancy (tenant owns endpoints), with two-level tenancy documented as a stretch goal.
2. HTTP intake only, no broker; the ledger integration lives in `examples/`.
3. Express and `pg` with plain SQL (no ORM), so the claim query is written and understood directly.
4. Standard Webhooks-style signing and retry schedule.
5. 30-day retention and a 20-endpoint cap per tenant.
6. No CI, no UI, no required deployment.
