# webhook-inbox

Multi-tenant, producer-agnostic webhook delivery service: signed requests, retries with jitter, per-endpoint circuit breakers, SSRF protection. PostgreSQL is both the store and the delivery queue.

See [`DESIGN.md`](./DESIGN.md) for what it guarantees (and why), and [`PLAN.md`](./PLAN.md) for the build plan.

**Status: phase 1 — tenancy and auth.** Tenant and API-key management live; event intake and dispatch come later. The phase checklist is in `PLAN.md` section 3.

## Quickstart

Requires Docker.

```sh
docker compose up --build
curl -s localhost:3000/health
```

`docker compose up` starts Postgres, runs the migrations, and starts the API. Postgres is exposed on the host as `127.0.0.1:5433` (to avoid colliding with a local Postgres).

Example — create a tenant and use its key (dev admin key from `docker-compose.yml`):

```sh
curl -s -X POST localhost:3000/admin/tenants \
  -H 'Authorization: Bearer whkadmin_dev_only' -H 'Content-Type: application/json' \
  -d '{"name":"acme"}'
# → {"tenant":{...},"apiKey":{"key":"whk_...","id":"..."}}  # save the key; shown once

curl -s localhost:3000/v1/me -H 'Authorization: Bearer whk_...'
```

## Development

```sh
npm install
npm test          # unit + integration tests; integration tests use Testcontainers,
                  # so the Docker daemon must be running
npm run lint
npm run format
npm run build

# Local API against the compose Postgres:
docker compose up -d postgres
npm run migrate
npm run api
```
