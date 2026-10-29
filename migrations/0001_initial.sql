-- Initial schema. See DESIGN.md section 4 for the reasoning behind each
-- decision. Native enums for closed sets, timestamptz everywhere,
-- snake_case names, and constraints enforced in the database.

CREATE TYPE endpoint_status AS ENUM ('enabled', 'disabled');
CREATE TYPE circuit_state   AS ENUM ('closed', 'open', 'half_open');
CREATE TYPE delivery_status AS ENUM ('pending', 'succeeded', 'dead');

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
