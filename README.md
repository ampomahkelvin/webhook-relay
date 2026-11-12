# webhook-inbox

Multi-tenant, producer-agnostic webhook delivery service: signed requests, retries with jitter, per-endpoint circuit breakers, SSRF protection. PostgreSQL is both the store and the delivery queue.

See [`DESIGN.md`](./DESIGN.md) for what it guarantees (and why), and [`PLAN.md`](./PLAN.md) for the build plan.

```
┌────────┐   POST /v1/events   ┌─────┐   claim (SKIP LOCKED, leases)   ┌────────────┐
│producer├────────────────────▶│ api │                                 │ dispatcher │
└────────┘  idempotency key   └──┬──┘                                 └─────┬──────┘
                                 │                                          │ signed HTTP,
                         ┌───────▼────────┐   one queue,   ┌───────────────▼──────┐
                         │    events      │  row-level     │    deliveries        │
                         │ + deliveries   │  leases        │ + delivery_attempts  │
                         └───────┬────────┘  + fencing     └──────────────────────┘
                                 │   ┌──────────────┐                    │
                                 └──▶│   Postgres   │◀───────────────────┘
                                     └──────┬───────┘
                                            │
                    ┌───────────────┬───────┴────────┬────────────┐
                    ▼               ▼                ▼            ▼
               /metrics        /health/deep    maintenance     Grafana /
               (Prometheus)    diagnostics     sweeps          Prometheus
```

One codebase, three processes (`api`, `dispatcher`, `maintenance`), all scraping-ready on `/metrics`; the sample receiver in [`examples/receiver`](./examples/receiver) verifies Standard Webhooks signatures.

**Status: feature-complete against `PLAN.md` phases 1–9** (endpoints, intake, SSRF hardening, dispatch, breakers, delivery API, maintenance + observability tests, security matrix, mutation experiments). Phase 10 is the demo/experience polish this repo is in now.

## Quickstart

Requires Docker (and that's it).

```sh
docker compose up --build
```

`docker compose up` starts **everything**: Postgres (host port `5433`), migrations, `api` (`3000`), `dispatcher`, `maintenance`, the sample receiver (`9000`), `demo-init`, plus Prometheus (`9090`) and Grafana (`3001`, login `admin` / `webhook_demo_only`, dashboard `Webhook Relay`). The api, receiver, Prometheus and Grafana ports are bound to `127.0.0.1` — the demo stack runs with dev-only credentials and unsafe flags, so nothing it exposes should answer on a shared network.

The stack opts into the dev-only flags (`ALLOW_INSECURE_HTTP`, `ALLOW_PRIVATE_TARGETS`) because the sample receiver lives on the Docker network — a private host the production defaults correctly refuse. The processes log a loud warning either way and `/health/deep` reports the flags.

The one-shot `demo-init` service creates the demo tenant and two endpoints on the receiver (a fast one and a deliberately slow one, `?delayMs=1500`), hands the receiver the server-generated signing secrets (no restart needed), and writes `./demo/demo-credentials.txt`:

```sh
cat demo/demo-credentials.txt
# API_KEY=whk_...      (shown only once — keep the file local)
```

## Take it for a spin

With compose up and `demo-credentials.txt` in hand:

```sh
source <(grep '^API_KEY=' demo/demo-credentials.txt)
FAST=$(grep '^ENDPOINT_ID_FAST=' demo/demo-credentials.txt | cut -d= -f2)
BASE=http://localhost:3000
```

1. **Submit an event and watch it arrive signed:**

   ```sh
   curl -si -X POST $BASE/v1/events \
     -H "Authorization: Bearer $API_KEY" -H 'Idempotency-Key: demo-1' \
     -H 'Content-Type: application/json' \
     -d '{"eventType":"invoice.paid","payload":{"order":"a1"}}'
   # grep the receiver's view:
   curl -s localhost:9000/__received | python3 -m json.tool
   ```

   The receiver verified `Webhook-Id`/`Webhook-Timestamp`/`Webhook-Signature` before accepting.

2. **Idempotency:** replay the exact same curl (same `Idempotency-Key`). Same `202` result, `Idempotent-Replayed: true` is returned instead of re-inserting, and `/__received` still shows exactly one copy.

3. **Retries and the breaker.** Point the fast endpoint at a receiver that always fails:

   ```sh
   curl -s -X PATCH $BASE/v1/endpoints/$FAST \
     -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
     -d '{"url":"http://receiver:9000/flaky?failRate=1"}' > /dev/null
   curl -si -X POST $BASE/v1/events -H "Authorization: Bearer $API_KEY" \
     -H 'Idempotency-Key: demo-2' -H 'Content-Type: application/json' \
     -d '{"eventType":"invoice.paid","payload":{"order":"a2"}}'
   ```

   Watch the attempt ledger grow, the breaker open (endpoint detail shows `circuitState: 'open'`), and delivery lag rise in Grafana. Point the URL back at `/hook` and the breaker half-opens, probes, and closes; the backlog drains.

4. **SSRF in practice (a stack with safe defaults).** The compose stack has `ALLOW_PRIVATE_TARGETS` on for its own receiver. On a default stack, registering `http://169.254.169.254/` is refused outright (`422`, cloud-metadata range), and a hostname that resolves private dies at the attempt level as `blocked_address` in `delivery_attempts`.

5. **Crash safety.** `docker compose kill dispatcher` mid-burst, then `docker compose start dispatcher`. Leases time out and every delivery still reaches the receiver — duplicates show up as `repeats` in `/__received`, nothing is lost.

## Deliveries you can query

```sh
curl -s "$BASE/v1/deliveries?endpointId=$FAST" -H "Authorization: Bearer $API_KEY" | python3 -m json.tool
# GET /v1/deliveries/:id includes the attempt ledger (number, duration, status, error kind)
```

Replay a dead delivery with `POST /v1/deliveries/:id/replay` once its receiver recovers; a disabled endpoint can be pinged with `POST /v1/endpoints/:id/test`, which returns a `202` with a `webhook.test` delivery id.

## Observability

- `GET /metrics` on `api:3000` / `dispatcher:3000` / `maintenance:3000` — Prometheus exposition with queue gauges (pending count, oldest-due age, open breakers), per-process counters, and an attempt-duration histogram.
- Grafana at `localhost:3001` (provisioned from `deploy/`) with the `Webhook Relay` dashboard; Prometheus at `localhost:9090`.

## Load scripts (`k6/`)

[`k6/intake.js`](k6/intake.js), [`k6/delivery.js`](k6/delivery.js), and [`k6/slow-receivers.js`](k6/slow-receivers.js) plus [`k6/README.md`](k6/README.md). They are dependency-free and syntax-verified; install `k6` once (`brew install k6`) to run them. **Measured results on named hardware/commit will land here when a machine with `k6` is available** — the scripts are written so the fairness claim (a slow endpoint must not starve a fast one) is directly falsifiable via `custom:lag_fast` vs `custom:lag_slow`.

## Development

```sh
npm install
npm test          # 272 tests; integration tests use Testcontainers, so Docker
                  # must be running; each test file gets a fresh database
npm run lint
npm run format:check
npm run build

# Local API against the compose Postgres:
docker compose up -d postgres
npm run migrate
npm run api
```

Test helpers worth knowing about: `test/helpers/test-db.ts` (Testcontainers Postgres + migrations), `test/helpers/receiver-server.ts` (the sample receiver on an ephemeral port), and `test/security/` (tenant-isolation matrix, log hygiene, SSRF client against real sockets). Mutation experiments are recorded in `DESIGN.md` section 17.

## Known limitations

- In-memory intake rate limiting only works per process; multi-instance needs Redis (`DESIGN.md` section 15).
- Metrics are per-process (runner gauges recompute per scrape); no cross-process aggregation.
- Signature format is the Standard Webhooks HMAC scheme only; asymmetric signatures are listed as a stretch goal.
- One-level tenancy; a two-level model has a documented migration path in `DESIGN.md`.
- `demo-credentials.txt` contains live dev credentials — don't commit it (it's gitignored).
