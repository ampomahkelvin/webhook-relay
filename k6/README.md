# k6 load scripts (PLAN phase 9)

Three load scenarios against the HTTP surface. **`k6` is not bundled with the repo
and is not installed in CI** — install it once (`brew install k6`) and run these
against a real stack (`docker compose up` includes Postgres, the API, and the
dispatcher). They were written against the API surface in `DESIGN.md` section 10
and kept dependency-free.

## Setup (once per stack, before any script)

```sh
BASE=http://localhost:3000   # whatever docker compose maps the API to (see below)
ADMIN_KEY=<ADMIN_API_KEY from .env>

# tenant + key (shown once)
TENANT_JSON=$(curl -s -X POST $BASE/admin/tenants \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"name": "k6"}')
API_KEY=$(echo "$TENANT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"]["key"])')

# endpoint(s). For a slow receiver, point the URL at the sample receiver with
# ?delayMs=1500. Keep the signingSecret — the sample receiver needs it.
curl -s -X POST $BASE/v1/endpoints -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url": "http://receiver:9410/hook", "eventTypes": ["*"]}'
```

## 1. `intake.js` — intake throughput and latency

```sh
k6 run -e BASE_URL=$BASE -e API_KEY=$API_KEY k6/intake.js
```

Ramping 0→50 VUs posting events with unique `Idempotency-Key`s (no replay short
circuit). Watch `http_req_duration` at 50 VUs, `custom:sent`, and
`custom:rejected_4xx` (the intake rate limiter answers `429` by design — a spike
here at the right request rate is the limiter working, not a bug).

## 2. `delivery.js` — end-to-end delivery lag

```sh
k6 run -e BASE_URL=$BASE -e API_KEY=$API_KEY \
       -e ENDPOINT_ID=<endpoint uuid> k6/delivery.js
```

Constant arrival rate of 5 events/s; each iteration submits an event, then polls
`GET /v1/deliveries?eventId=…` until it reaches `succeeded` or `dead`, and
records submit→settled as `custom:lag_ms` (thresholds: p90 < 2 s, p95 < 5 s).
This is the number that matters for the queue: how long the whole pipeline
takes per event, not per request.

## 3. `slow-receivers.js` — fairness with one slow endpoint

```sh
k6 run -e BASE_URL=$BASE -e API_KEY=$API_KEY \
       -e FAST_ENDPOINT_ID=<uuid> -e SLOW_ENDPOINT_ID=<uuid> k6/slow-receivers.js
```

Requires two endpoint resources on the same tenant: one pointing at a fast
receiver, one at a receiver that sleeps (e.g. `?delayMs=1500`). The point is
the **fairness claim in the design**: the per-endpoint claim cap means the slow
endpoint's retries must not starve the fast one, so `custom:lag_fast`'s p95
stays bounded even while `custom:lag_slow` grows into seconds. If the fast
p95 tracks the slow average, the claim cap is not doing its job.

## Notes

- `Idempotency-Key` is required on intake (1–200 chars), so every script sends
  one; keys embed VU/iteration/timestamp so parallel k6 instances coexist.
- Scripts poll the read API at 100–150 ms per iteration; for very high arrival
  rates that polling itself becomes load — read `https_req_duration` with that
  in mind or run `delivery.js` with a lower `-e RATE`.
- Metrics parity: the same numbers exist on `/metrics` (Prometheus), so a k6 run
  can be corroborated by watching `webhook_deliveries_status` gauges and the
  attempt-duration histogram while the script is running.
