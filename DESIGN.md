# Webhook Delivery Service

A multi-tenant, producer-agnostic webhook delivery service. Any system can send it events over HTTP; it delivers each event to the subscribed endpoints of that tenant with signed requests, retries with backoff, per-endpoint circuit breaking, and SSRF protection. Everything is stored in PostgreSQL, which is also the delivery queue.

This document explains what the service guarantees, how it achieves those guarantees, and which trade-offs were made on purpose.

---

## 1. Goals and non-goals

**Goals**

- An event accepted by the API is never lost, and is delivered **at least once** to every matching endpoint.
- One slow or failing endpoint never delays deliveries to other endpoints.
- Receivers can verify that a request came from the service and was not replayed.
- The service cannot be used to attack the network it runs in (SSRF).
- Every delivery attempt is recorded, and a failed delivery can be replayed.
- Producers can safely retry event submission (idempotent intake).

**Non-goals (v1)**

- Exactly-once delivery. It is not achievable over HTTP; receivers dedupe on `Webhook-Id`.
- Ordering. Deliveries may arrive out of order, including for the same endpoint. This is documented, not hidden.
- A UI, payload transformation, or event-type catalogs.
- Two-level tenancy (tenant → applications → endpoints). See section 15.

**Governing rule:** a delivery's state lives in one row in Postgres. Workers are stateless and disposable. If any worker dies at any moment, the delivery is still in the database and will be retried.

---

## 2. Concepts

| Term         | Meaning                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| **Tenant**   | An account. Owns API keys, endpoints, and events.                                      |
| **Endpoint** | A receiver URL registered by a tenant, with a signing secret and an event-type filter. |
| **Event**    | Something a producer reports: a type (`invoice.paid`) and a JSON payload.              |
| **Delivery** | The obligation to deliver one event to one endpoint. One row, with a lifecycle.        |
| **Attempt**  | One HTTP request made for a delivery. Append-only log.                                 |

An event fans out to one delivery per matching, enabled endpoint of the same tenant.

---

## 3. Architecture

```
 Producer ──POST /v1/events──►┌───────────────────┐
 (any system)  (Idempotency-  │  api              │
                Key)          │  intake + manage  │
                              └─────────┬─────────┘
                                        │ one txn: event + deliveries
                                 ┌──────▼──────┐
                                 │ PostgreSQL  │◄─────────────┐
                                 │ (also the   │              │
                                 │  queue)     │      ┌───────┴────────┐
                                 └──────┬──────┘      │ maintenance    │
                       claim due        │             │ - retention    │
                       (lease, SKIP     │             │ - expiry sweep │
                        LOCKED)         │             │ - auto-disable │
                              ┌─────────▼─────────┐   └────────────────┘
                              │ dispatcher (×N)   │
                              │ sign → SSRF-safe  │──HTTPS──► Receivers
                              │ POST → record     │
                              └───────────────────┘

 api, dispatcher, maintenance expose /metrics ──► Prometheus ──► Grafana
```

| Process       | Responsibility                                                            | Scaling                                     |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| `api`         | Intake, endpoint and delivery management, auth, intake rate limiting      | Horizontal, stateless                       |
| `dispatcher`  | Claim due deliveries, send, record results, drive retries and the breaker | Horizontal (leases keep instances disjoint) |
| `maintenance` | Retention pruning, expiry sweep, auto-disable of long-failing endpoints   | Single instance (advisory lock)             |

One codebase and one image, with three entrypoints.

### Why Postgres is the queue (and RabbitMQ is not used)

|                                   | Postgres rows with `next_attempt_at` (chosen) | Broker with retry queues            |
| --------------------------------- | --------------------------------------------- | ----------------------------------- |
| Retry schedule                    | Any schedule, with per-delivery jitter        | One fixed TTL per retry queue       |
| Delivery history, replay, filters | Same rows, queryable                          | Needs a second store                |
| Per-endpoint pause and fairness   | A `WHERE` clause                              | Awkward; needs a queue per endpoint |
| Atomic intake                     | Event and deliveries commit together          | Dual write: DB and broker           |
| Latency                           | Polling interval (sub-second)                 | Push                                |
| Throughput ceiling                | Thousands per second on one primary           | Higher                              |

The ledger project needed an outbox because its source of truth (Postgres) and its transport (RabbitMQ) were two systems that cannot commit atomically. Here intake writes the event and its deliveries in **one transaction** in the same database that the dispatchers read, so that problem does not exist. The cost is a throughput ceiling and polling latency, both acceptable for this scope.

---

## 4. Data model (PostgreSQL)

Seven tables. Native enums for closed sets, `timestamptz` everywhere, `snake_case` names, and constraints in the database.

```sql
CREATE TYPE endpoint_status   AS ENUM ('enabled', 'disabled');
CREATE TYPE circuit_state     AS ENUM ('closed', 'open', 'half_open');
CREATE TYPE delivery_status   AS ENUM ('pending', 'succeeded', 'dead');

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  key_hash    bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),  -- SHA-256
  key_prefix  text NOT NULL,          -- first characters, to identify a key in listings
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

CREATE TABLE endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  url                  text NOT NULL CHECK (length(url) <= 2048),
  description          text CHECK (length(description) <= 500),
  event_types          text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 50),
  secret_ciphertext    bytea NOT NULL,           -- AES-256-GCM: nonce || ciphertext || tag
  status               endpoint_status NOT NULL DEFAULT 'enabled',
  disabled_reason      text CHECK (disabled_reason IN ('manual', 'gone', 'failing')),
  circuit_state        circuit_state NOT NULL DEFAULT 'closed',
  consecutive_failures int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failing_since        timestamptz,              -- set on first failure, cleared on success
  circuit_opened_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT endpoints_disabled_has_reason
    CHECK ((status = 'disabled') = (disabled_reason IS NOT NULL)),
  CONSTRAINT endpoints_open_has_timestamp
    CHECK (circuit_state = 'closed' OR circuit_opened_at IS NOT NULL)
);
CREATE INDEX endpoints_tenant_idx ON endpoints (tenant_id, created_at DESC);

CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  event_type       text NOT NULL CHECK (event_type ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
                                        AND length(event_type) <= 100),
  payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash     bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_idempotency_key UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX events_created_at_idx ON events (created_at);   -- retention pruning

CREATE TABLE deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
  status          delivery_status NOT NULL DEFAULT 'pending',
  attempt_count   int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),  -- lifetime; fencing token
  cycle_start     int NOT NULL DEFAULT 0,                              -- attempt_count at last (re)start
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,                                         -- lease
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT deliveries_event_endpoint UNIQUE (event_id, endpoint_id),
  CONSTRAINT deliveries_completed_matches_status
    CHECK ((status = 'pending') = (completed_at IS NULL))
);
CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX deliveries_endpoint_idx ON deliveries (endpoint_id, created_at DESC);

CREATE TABLE delivery_attempts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id      uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  attempt_number   int NOT NULL,
  started_at       timestamptz NOT NULL,
  duration_ms      int NOT NULL CHECK (duration_ms >= 0),
  status_code      smallint,                      -- NULL when no HTTP response
  error_kind       text CHECK (error_kind IN ('timeout', 'connection', 'dns', 'tls',
                                              'blocked_address', 'redirect', 'http_status')),
  response_snippet text CHECK (length(response_snippet) <= 1024),
  CONSTRAINT delivery_attempts_number UNIQUE (delivery_id, attempt_number)
);
```

### Schema decisions

- **The idempotency key is a column on `events`, not a separate table.** The resource being created is its own record: `UNIQUE (tenant_id, idempotency_key)` plus a request hash is enough. A replay is derived (event ID and delivery count), so no cached response is needed. (The ledger needed a separate table because its responses had to be stored.)
- **Deliveries and attempts cascade-delete with their event; the ledger used `RESTRICT`.** These rows are operational data with a retention policy, so a cascading prune is correct. The ledger rows were a financial record that is never deleted.
- **`attempt_count` is the fencing token, and `cycle_start` supports replay.** `attempt_count` only increases, so `(delivery_id, attempt_number)` stays unique forever. A replay sets `cycle_start = attempt_count`, so the retry schedule restarts without renumbering history.
- **Statuses are only `pending`, `succeeded`, `dead`.** "Failed but will retry" is simply `pending` with `attempt_count > cycle_start`. Fewer states means fewer invalid transitions.
- **Breaker state lives on `endpoints`,** because it is a property of the receiver, not of any one delivery.
- **`event_types` is a `text[]`,** with `'*'` meaning all. A join table would add integrity for a list that is small, owned by one endpoint, and always read with it. Matching is `'*' = ANY(event_types) OR $type = ANY(event_types)`.
- **Endpoints per tenant are capped (default 20).** This bounds fan-out, which is why event intake can create all deliveries in one transaction.
- **Not tables:** event-type catalogs, signing-secret history (rotation is a stretch goal), per-attempt request headers, and tenant settings.

### Retention

`maintenance` deletes events older than `RETENTION_DAYS` (default 30), and their deliveries and attempts cascade. The idempotency window for event submission equals the retention window.

---

## 5. Event intake

`POST /v1/events` with header `Idempotency-Key`, body `{ "eventType": "invoice.paid", "payload": { ... } }`.

```sql
-- One transaction
WITH ev AS (
  INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id
)
INSERT INTO deliveries (event_id, endpoint_id)
SELECT ev.id, e.id
FROM ev
JOIN endpoints e ON e.tenant_id = $1
 AND e.status = 'enabled'
 AND ('*' = ANY(e.event_types) OR $2 = ANY(e.event_types));
```

- **New event:** returns `202` with `{ id, deliveries: n }` once the transaction commits. After that response the event is durable.
- **Same key, same request hash:** the insert conflicts, the existing event is loaded, and the same `202` is returned with `Idempotent-Replayed: true`.
- **Same key, different hash:** `422 IDEMPOTENCY_KEY_REUSED`.
- **Concurrent duplicates:** the second insert waits on the unique index, then takes the replay path. (Requires `READ COMMITTED`.)
- **Endpoints that are `disabled` get no delivery.** Endpoints whose breaker is open still get deliveries; they queue until the breaker allows sending.
- **Limits:** payload at most 256 KB (enforced at the body parser), JSON object only, per-tenant token-bucket rate limit (in memory in v1; Redis if the API is scaled out).

---

## 6. Dispatch

### 6.1 Claiming: leases, not long transactions

A dispatcher never holds a database transaction while making an HTTP call. It **leases** deliveries in a short transaction and works on them outside it.

```sql
-- Sketch; the exact query is pinned down by the concurrency tests.
WITH ranked AS (                      -- fairness: at most K claimable per endpoint
  SELECT d.id,
         row_number() OVER (PARTITION BY d.endpoint_id
                            ORDER BY d.next_attempt_at, d.id) AS rn
  FROM deliveries d
  JOIN endpoints e ON e.id = d.endpoint_id
  WHERE d.status = 'pending'
    AND d.next_attempt_at <= now()
    AND (d.locked_until IS NULL OR d.locked_until < now())
    AND e.status = 'enabled'
    AND (e.circuit_state = 'closed'
         OR (e.circuit_state = 'open'
             AND e.circuit_opened_at + $cooldown <= now()))
), picked AS (
  SELECT id FROM ranked WHERE rn <= $per_endpoint LIMIT $batch
)
UPDATE deliveries d
SET locked_until  = now() + $lease,
    attempt_count = d.attempt_count + 1
FROM (SELECT id FROM deliveries
      WHERE id IN (SELECT id FROM picked)
        AND status = 'pending'
        AND (locked_until IS NULL OR locked_until < now())
      FOR UPDATE SKIP LOCKED) c
WHERE d.id = c.id
RETURNING d.id, d.event_id, d.endpoint_id, d.attempt_count;
```

- `FOR UPDATE SKIP LOCKED` on the inner select, plus re-checking the lease condition, makes concurrent dispatchers claim **disjoint** sets.
- `attempt_count` is incremented at claim time, so the claimed number is this attempt's identity.
- **Lease length** is the request timeout plus a margin (default 60 s). If a dispatcher dies mid-send, the lease expires and the delivery is claimed again. That is the source of at-least-once duplicates, and it is the correct behavior.
- **Fairness:** the ranking caps how many deliveries one endpoint can take per batch, so a backlog on one endpoint cannot crowd out others. In-flight leases for an endpoint are subtracted from its capacity.
- **Oldest due first, across endpoints too:** after the per-endpoint ranking, the batch is taken in `next_attempt_at` order — a long-overdue delivery is never left waiting behind newer ones just because a random UUID sorted first.
- **Clocks:** the claim statement takes `now` as a parameter (injectable for deterministic tests), and the deployment requirement that goes with it: **all dispatcher hosts must run NTP-synchronized clocks**, because leases and breaker cooldowns are compared against timestamps written by whichever instance claimed. Single-digit-millisecond NTP sync is assumed; a multi-minute skew would shorten or stretch leases and cooldowns accordingly.
- **Half-open probing:** when an open breaker's cooldown has passed, the claim takes exactly one delivery and moves the endpoint to `half_open` in the same transaction.
- **Do not sleep when there is more work.** If a claim returns a full batch, the dispatcher claims again immediately, and only sleeps (default 500 ms) when a claim comes back short. (The ledger's relay had a throughput cap of batch size divided by poll interval; this rule avoids it.)
- A dispatcher runs up to `CONCURRENCY` sends in parallel (default 50) and claims only as many deliveries as it has free slots.

### 6.2 Sending

For each claimed delivery the dispatcher builds the request, signs it, sends it through the SSRF-safe client (section 8), and classifies the result.

**Request**

```
POST <endpoint url>
Content-Type: application/json
User-Agent: webhook-service/1.0
Webhook-Id: <event id>
Webhook-Timestamp: <unix seconds at this attempt>
Webhook-Signature: v1,<base64 HMAC-SHA256>

{ "id": "<event id>", "type": "invoice.paid", "createdAt": "<ISO-8601>", "data": { ...payload } }
```

**Signature** (Standard Webhooks style): `HMAC-SHA256(secret, "<id>.<timestamp>.<raw body>")`, base64-encoded, secret in the form `whsec_<base64 of 32 random bytes>`.

- The timestamp is regenerated per attempt, so a retry hours later still passes a receiver's 5-minute tolerance.
- The body that is signed is exactly the bytes that are sent.
- Receivers must compare in constant time and reject timestamps outside the tolerance, which defeats replay of captured requests.
- `Webhook-Id` is the event ID, stable across retries and manual replays, which is what receivers dedupe on.
- The signing secret is decrypted just in time (AES-256-GCM, key from environment) and never logged. It is shown to the tenant once, at creation.

### 6.3 Classifying results

| Result                              | Outcome                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `2xx`                               | **Success.** Delivery `succeeded`.                                                         |
| `410 Gone`                          | Endpoint is gone: delivery `dead`, endpoint disabled (`gone`).                             |
| `429`, `503` with `Retry-After`     | Retry no earlier than the header says (capped at 1 h and never earlier than the schedule). |
| Any other `4xx` or `5xx`            | Failure, retry per schedule.                                                               |
| `3xx`                               | Failure (redirects are never followed), retry.                                             |
| Timeout, connection, DNS, TLS error | Failure, retry.                                                                            |
| Resolves to a blocked address       | Failure, retry (the DNS answer may change); recorded as `blocked_address`.                 |

**Retry schedule** (Standard Webhooks style): attempts at roughly `0, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h` after the delivery was created, each with ±20% jitter. The schedule index is `attempt_count - cycle_start`. After the eighth failed attempt the delivery is `dead` (about 28 hours in total).

### 6.4 Recording results, with fencing

After a send the dispatcher records the outcome in one short transaction:

```sql
INSERT INTO delivery_attempts (...) VALUES (...)
ON CONFLICT (delivery_id, attempt_number) DO NOTHING;

UPDATE deliveries
SET status = $status, next_attempt_at = $next, locked_until = NULL, completed_at = $done
WHERE id = $id
  AND attempt_count = $claimed_attempt      -- fencing
  AND status = 'pending';
```

If the update affects zero rows, this worker is **stale**: its lease expired and another dispatcher claimed a newer attempt (or a replay restarted the cycle). The stale worker records its attempt row (that request really happened) but must not touch the delivery or the endpoint's breaker. This prevents a slow worker from overwriting newer state.

---

## 7. Circuit breaker and endpoint health

Per-endpoint state on `endpoints`:

- **closed:** normal.
- **open:** after `BREAKER_THRESHOLD` (default 5) consecutive failures. No claims for `BREAKER_COOLDOWN` (default 60 s). Deliveries keep accruing.
- **half_open:** after the cooldown, one probe delivery is sent. Success closes the breaker and clears the failure counters. Failure reopens it.

**Write amplification rule:** a success on an already-healthy endpoint (`closed`, zero failures) does not write the endpoint row at all. Only failures and recoveries update it, so a busy healthy endpoint does not become a hot row.

**Auto-disable:** `maintenance` disables an endpoint (`failing`) whose `failing_since` is older than `AUTO_DISABLE_AFTER` (default 5 days). Pending deliveries for a disabled endpoint stay pending and unclaimed until the endpoint is re-enabled or they expire.

**Expiry sweep:** `maintenance` marks `pending` deliveries older than `DELIVERY_MAX_AGE` (default 3 days) as `dead`, so breaker-blocked or disabled endpoints cannot hold deliveries forever.

---

## 8. SSRF protection

The service makes HTTP requests to URLs that tenants control. Without protection, a tenant could point an endpoint at `http://169.254.169.254/` (cloud metadata), `http://localhost:5432`, or an internal admin service and read responses through the attempt log.

**Layer 1: at registration (fast feedback).** Parse the URL with the WHATWG parser (which normalizes tricks such as decimal or octal IP literals), require `https` (plain `http` only behind `ALLOW_INSECURE_HTTP=true`), reject embedded credentials, and reject literal IPs in blocked ranges. This is a convenience, not the defense.

**Layer 2: at send time (the real defense).**

1. Resolve the hostname to **all** addresses.
2. If **any** address is in a blocked range, fail the attempt (`blocked_address`).
3. Connect to the **validated IP**, with a custom `lookup` that returns it, while keeping the original hostname for the `Host` header, TLS SNI, and certificate verification. The hostname is never resolved a second time, which defeats DNS rebinding (an attacker's DNS answering public on the check and private on the connect).
4. Never follow redirects (a `302` to an internal address would bypass the check).
5. Verify TLS certificates. Set a connect timeout (5 s) and a total timeout (10 s).
6. Read at most 64 KB of the response, then abort. Store at most 1 KB of it.

**Blocked ranges:**

| Family | Ranges                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IPv4   | `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4` |
| IPv6   | `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`; IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses are unwrapped and checked as IPv4                        |

**Development escape hatch:** `ALLOW_PRIVATE_TARGETS=true` disables layer 2's IP check so the demo receiver can run on the Docker network. It is off by default, logs a loud warning at startup, and is reported by `/health/deep`.

---

## 9. Security

- **API keys:** 32 random bytes, shown once, stored as a SHA-256 hash (the keys are high-entropy, so a fast hash is appropriate). Sent as `Authorization: Bearer whk_<...>`. Keys can be revoked.
- **Tenant isolation:** every query is scoped by `tenant_id` (through the key). Accessing another tenant's resource returns `404`, not `403`, so IDs do not leak existence. Isolation is covered by tests for every endpoint.
- **Admin API:** tenant creation (`POST /admin/tenants`) requires a separate admin key from configuration.
- **Secrets at rest:** signing secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY` from the environment. Logs never contain secrets, API keys, or payloads (IDs only).
- **Input validation:** Zod on every request; strict event-type format; payload size and shape limits.
- **Rate limiting:** per-tenant on intake; `429` with `Retry-After`.
- **Least privilege:** the app's database role does not need to own tables (migrations run as a separate role).

---

## 10. API surface

| Method | Path                                  | Notes                                                          |
| ------ | ------------------------------------- | -------------------------------------------------------------- |
| POST   | `/v1/events`                          | Idempotent. `202`.                                             |
| GET    | `/v1/events/:id`                      | Event and its deliveries                                       |
| POST   | `/v1/endpoints`                       | Returns the signing secret once                                |
| GET    | `/v1/endpoints`                       | Cursor-paginated                                               |
| GET    | `/v1/endpoints/:id`                   | Includes breaker state                                         |
| PATCH  | `/v1/endpoints/:id`                   | URL, event types, enable or disable                            |
| DELETE | `/v1/endpoints/:id`                   | Cascades its deliveries                                        |
| POST   | `/v1/endpoints/:id/test`              | Sends a `webhook.test` event to this endpoint only             |
| GET    | `/v1/deliveries`                      | Filter by `endpointId`, `status`, `eventId`; cursor-paginated  |
| GET    | `/v1/deliveries/:id`                  | Includes the attempt log                                       |
| POST   | `/v1/deliveries/:id/replay`           | For `dead` or `succeeded` deliveries; restarts the retry cycle |
| POST   | `/admin/tenants`                      | Admin key; creates a tenant and its first API key              |
| GET    | `/health`, `/health/deep`, `/metrics` | Deep health reports delivery lag and unsafe config flags       |

Errors use one shape, `{ code, message }`, with correct status codes (400, 401, 404, 409, 422, 429). A global handler maps typed errors; Postgres unique violations map to 409.

---

## 11. Observability

- Structured JSON logs (pino) carrying `eventId`, `deliveryId`, `endpointId`, and `attempt`. No secrets or payloads.
- Prometheus metrics, with a Grafana dashboard provisioned from files.

| Metric                                          | Why                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `events_received_total`                         | Intake rate                                                                                       |
| `deliveries_total{outcome}`                     | Success, retry, dead                                                                              |
| `delivery_attempt_duration_seconds` (histogram) | Receiver latency                                                                                  |
| `deliveries_pending` (gauge)                    | Backlog                                                                                           |
| **`oldest_due_delivery_age_seconds`** (gauge)   | **Delivery lag: how late the most overdue claimable delivery is. The single most useful number.** |
| `endpoints_circuit_open` (gauge)                | Unhealthy receivers                                                                               |
| `intake_rate_limited_total`                     | Producer pressure                                                                                 |

Gauges are computed from the database (using the partial indexes) and cached for 5 seconds.

---

## 12. Failure modes

| Scenario                                    | Behavior                                                       | Proved by                  |
| ------------------------------------------- | -------------------------------------------------------------- | -------------------------- |
| Producer retries a submission               | Same key and hash: one event, same `202`                       | Replay test                |
| 50 identical submissions at once            | One event, one delivery per endpoint                           | Parallel same-key test     |
| Same key, different payload                 | `422`                                                          | Hash-mismatch test         |
| Intake fails midway                         | Transaction rolls back: no event, no deliveries                | Fault-injection test       |
| Dispatcher crashes mid-send                 | Lease expires; delivery retried (receiver may see a duplicate) | Kill test                  |
| Two dispatchers at once                     | Disjoint claims; no concurrent double-send                     | Claim concurrency test     |
| Slow worker finishes after losing its lease | Fenced: attempt logged, delivery untouched                     | Stale-worker test          |
| Receiver returns 500 forever                | Retries on schedule, breaker opens, delivery `dead`            | Schedule and breaker tests |
| One endpoint hangs                          | Other endpoints keep flowing                                   | Fairness test              |
| Receiver replies 429 with `Retry-After`     | Next attempt not earlier than the header                       | Retry-After test           |
| Receiver replies 410                        | Delivery dead, endpoint disabled                               | Classification test        |
| Endpoint resolves to `127.0.0.1`            | Blocked, never connected                                       | SSRF test matrix           |
| DNS answers public, then private            | Blocked: single resolution, connect to validated IP            | Rebinding test             |
| Redirect to an internal address             | Not followed; attempt is a failure                             | Redirect test              |
| Receiver replies with a huge body           | Read stops at 64 KB                                            | Size-limit test            |
| Tenant A requests tenant B's resource       | `404`                                                          | Isolation tests            |
| Database restarts                           | In-flight leases expire; dispatchers reconnect and resume      | Outage test                |

---

## 13. Example integrations (in `examples/`, not part of the core)

- **`receiver/`**: a small Express app that verifies signatures (constant-time compare and timestamp tolerance), dedupes on `Webhook-Id`, and can misbehave on demand (`/flaky?failRate=0.5`, fixed latency, `429` with `Retry-After`, `410`). It is the reference for how a receiver should be written, and the demo target.
- **`ledger-bridge/`**: a small consumer of the wallet ledger's `wallet.events` exchange that POSTs each event to `/v1/events`, using the ledger's event ID as the `Idempotency-Key`. It shows the service working for a real producer without any coupling in the core.

---

## 14. Known limitations

- **No ordering guarantee.** Concurrent dispatchers and retries reorder deliveries. Per-endpoint ordered delivery is a stretch goal (it needs a single-flight constraint per endpoint).
- **At-least-once duplicates** after crashes or lease expiry; receivers must dedupe.
- **Polling latency** of up to the poll interval (500 ms by default) when idle.
- **Throughput ceiling** is the Postgres primary. The claim and result transactions are short, which helps, but this is not a million-per-second design.
- **Hot endpoint row** for failing endpoints (counter updates); healthy endpoints are not written on success.
- **In-memory intake rate limit** is per API instance.
- **Secrets encrypted with one environment key,** with no rotation of the encryption key.

---

## 15. Stretch goals

- **Two-level tenancy** (tenant → applications → endpoints, as in webhooks-as-a-service products). Migration path: add `applications`, move `endpoints.tenant_id` to `application_id`, and add an application path segment to intake.
- **Signing-secret rotation** with an overlap window (sign with both secrets, space-delimited in the header).
- **Wake-ups with `LISTEN/NOTIFY`** instead of polling.
- **Prefix event-type filters** (`invoice.*`).
- **Redis-backed intake rate limiting** once the API runs multiple instances.
- **Per-endpoint ordering** via a single-flight constraint.
- **Asymmetric signatures** (Ed25519) alongside HMAC.

---

## 16. Decision log

| Decision                                  | Alternative                             | Reason                                                                                |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| Postgres as the queue                     | RabbitMQ with retry queues              | Atomic intake, flexible per-delivery schedules, replay and history from the same rows |
| HTTP intake, no broker                    | Consume from a broker                   | Producer-agnostic; no dual-write problem to solve                                     |
| Lease and short transactions              | Hold a transaction during the HTTP call | Row locks are never held across network I/O                                           |
| Fencing by `attempt_count`                | Trust the lease                         | A slow worker cannot overwrite newer state                                            |
| At-least-once                             | Exactly-once                            | Not achievable over HTTP; receivers dedupe on `Webhook-Id`                            |
| Idempotency key as an event column        | Separate idempotency table              | The resource is its own record; replay is derived                                     |
| Standard Webhooks signing and schedule    | Custom scheme                           | Interoperable with existing receiver libraries                                        |
| Resolve once, connect to the validated IP | Validate, then let the client resolve   | Defeats DNS rebinding                                                                 |
| No redirects                              | Follow with re-validation               | Simpler and safer; webhooks should not redirect                                       |
| Breaker state on `endpoints`              | Per-delivery retry state only           | The receiver's health is shared by all its deliveries                                 |
| Cascade deletes for retention             | `RESTRICT` as in the ledger             | Operational data with a retention policy                                              |
| Native enums for closed sets              | Lookup tables                           | Fewer joins, readable SQL                                                             |
| One-level tenancy                         | Two-level                               | The extra layer adds surface without adding hard problems; documented migration path  |
| Cap endpoints per tenant                  | Unbounded fan-out                       | Keeps intake a single bounded transaction                                             |

---

## 17. Hardening verification (experiments, phase 9)

### 17.1 Tenant-isolation matrix

`test/security/tenant-isolation.test.ts` drives two tenants (alice/bob) through the real HTTP
app against a disposable database and asserts, for **every** route family: a foreign id reads
as `404` (events, endpoints, deliveries), foreign writes (`replay`, `test`, `PATCH`, `DELETE`)
are `404` and provably change nothing, a foreign scope in a listing filter yields an empty
page, and the admin namespace rejects tenant keys and anonymity. The endpoint baseline is
captured with a `GET` (the create response intentionally omits breaker state, which is
`null` until first observed).

### 17.2 Log hygiene

`test/security/log-hygiene.test.ts` runs a full flow — tenant + key creation, endpoint with a
server-generated secret, intake with sentinel values in the payload and `Idempotency-Key`, a
signed delivery, a replay, listings, metrics, deep health — with pino sinks capturing
**everything** both `api` and `dispatcher` log, then asserts no admin key, tenant API key,
signing secret, idempotency key, or payload content appears anywhere in the captured stream.

**Two real leaks were found (and fixed in `src/api/app.ts`):** pino-http logs the raw request
headers, so `Authorization: Bearer <key>` and `Idempotency-Key` went to stdout verbatim on the
request-completed line. Both are now redacted with a pino `redact` allow-list-style path list.
Without the sentinel test the leak ships silently; the fix is the cheapest possible (two
redaction paths, zero behavior change).

### 17.3 Mutation experiments — results

Each mutation is applied to a working copy, its targeted test is run, and the change is
reverted. A mutation that does **not** fail its test is a diagnostic finding, recorded below.

| #   | Mutation                                                   | Target test                                                       | Result                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Remove `SKIP LOCKED` + lease re-check from the claim       | `test/concurrency/dispatchers.test.ts`                            | **Killed** — 1 failure (two dispatchers double-claimed)                                                                                                                                                                                                                                                                                                                    |
| 2   | Remove `attempt_count` fencing from the result update      | `test/integration/record-fencing.test.ts`                         | **Killed** — 2 failures (stale worker overwrote newer state)                                                                                                                                                                                                                                                                                                               |
| 3   | No pinned IP (resolve again at connect time)               | `test/security/ssrf-client.test.ts`                               | **Killed** — 7 failures (rebound to a private address reached the socket)                                                                                                                                                                                                                                                                                                  |
| 4   | Follow one redirect (re-requesting `Location`)             | `test/security/ssrf-client.test.ts`                               | **Killed** — 1 failure (redirect-refusal test; the mutated client hung on the private redirect target until its timeout — the test surfaced as its own slow failure)                                                                                                                                                                                                       |
| 5   | Drop `UNIQUE (tenant_id, idempotency_key)` + `ON CONFLICT` | `test/integration/intake.test.ts`                                 | **Killed** — 3 failures (parallel same-key coalescing)                                                                                                                                                                                                                                                                                                                     |
| 6   | Ignore `Retry-After` on 429/503                            | `test/unit/classify.test.ts`                                      | **Killed** — 2 failures                                                                                                                                                                                                                                                                                                                                                    |
| 7   | Sign without the timestamp                                 | `test/unit/verification.test.ts` then `test/unit/signing.test.ts` | **Finding.** `verification.test.ts` (8 tests) does **not** fail: `verify` and `sign` share one code path, so its checks exercise header tolerance independently of what is signed. The spec known-answer vectors in `signing.test.ts` **do** fail (3 tests, including the Standard Webhooks vector) — the timestamp binding is covered, but only through external vectors. |
| 8   | Sleep after every full batch (no immediate re-claim)       | `test/integration/loop.test.ts`                                   | **Killed** — 1 failure (the full-batch drain exceeded its bound by more than a poll interval; test took 10 s)                                                                                                                                                                                                                                                              |
| 9   | Remove the per-endpoint claim cap                          | `test/integration/claim-lease.test.ts`                            | **Killed** — exactly the 2 per-endpoint capacity tests fail (over-claim within a batch; in-flight subtraction untestable with the cap at 999 999), the other 6 pass                                                                                                                                                                                                        |

Two failed first attempts are kept in the record because they taught something: mutation 5's
naive edit (deleting the constraint line while leaving the preceding comma) broke the SQL so
the whole suite crashed at migration time — a mutation suite must verify it applies a valid
program. Mutation 9's first edit removed the `(tenant_id, ...)` `$3` from the SQL but left it
in the params array; Postgres rejected the query (`could not determine data type of parameter
$3`) and all 8 tests failed for the wrong reason — the kill must be behavioral, so the param
list was renumbered and re-run before counting it as killed.

**Verdict: 8 of 9 killed; mutation 7 exposed an imprint coverage gap** that was closed by the
independent known-answer vectors rather than by changing `verification.test.ts`'s contract.
