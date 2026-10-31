# Sample receiver

A small Express app demonstrating how to receive webhooks from this service
correctly. It is the reference for the receiving side and the demo target
(`DESIGN.md` section 13) — not part of the core service.

```sh
npm install
WEBHOOK_SECRET=whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw npm start   # :9000
```

## What a correct receiver does

1. **Verifies the signature.** `Webhook-Signature` is `v1,<base64>` over
   `<Webhook-Id>.<Webhook-Timestamp>.<raw body>` with the endpoint's secret.
   The verification runs on the raw body bytes, compares in constant time,
   and rejects timestamps outside a tolerance (default 5 minutes) — so a
   captured request cannot be replayed.
2. **Dedupes on `Webhook-Id`.** Delivery is at-least-once: crashes and lease
   expiry can duplicate a webhook, so the same `Webhook-Id` twice is normal,
   and the response says `duplicate: true`.
3. **Answers fast.** Acknowledge first, process later.

## Routes

| Route                                                       | Behavior                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `POST /hook`                                                | Verify + dedupe. `200 { received: true, duplicate }`, or `401 { reason }`. |
| `POST /flaky?failRate=0.5&status=429&retryAfterSeconds=120` | Random failures (default 500) with an optional `Retry-After`.              |
| `POST /too-slow?delayMs=5000`                               | Waits before answering.                                                    |
| `POST /retry-after?retryAfterSeconds=900&status=503`        | Always responds `429`/`503` with `Retry-After`.                            |
| `POST /gone`                                                | Always `410` — the endpoint is gone.                                       |
| `GET /__received`                                           | Everything accepted so far (in-memory).                                    |
| `POST /__reset`                                             | Clears the in-memory store.                                                |
| `GET /__health`                                             | Liveness.                                                                  |

The misbehavior switches exist so the dispatcher's retry schedule,
`Retry-After` handling, and circuit breaker can be exercised directly.

## Configuration

| Variable            | Default                | Meaning                                              |
| ------------------- | ---------------------- | ---------------------------------------------------- |
| `WEBHOOK_SECRET`    | the spec's demo secret | The `whsec_...` secret of the endpoint pointing here |
| `PORT`              | `9000`                 | Listen port                                          |
| `TOLERANCE_SECONDS` | `300`                  | Signature timestamp tolerance                        |
