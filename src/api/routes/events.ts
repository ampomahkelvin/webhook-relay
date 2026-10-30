import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { AppError, parseBody } from '../errors.js'
import { TokenBucket } from '../rate-limit.js'
import { canonicalJson } from '../../util/canonical-json.js'
import { isUuid } from '../../util/uuid.js'

export interface IntakeOptions {
  ratePerMinute: number
  burst: number
}

const MAX_PAYLOAD_BYTES = 256 * 1024
const EVENT_TYPE_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/

const intakeSchema = z.object({
  eventType: z
    .string()
    .regex(EVENT_TYPE_PATTERN, 'must be lowercase a-z/0-9 words joined by . _ or -')
    .max(100),
  payload: z.record(z.string(), z.unknown()),
})

interface IntakeResultRow {
  new_event_id: string | null
  new_deliveries: string // bigint comes back as string
  replay_event_id: string | null
  replay_deliveries: string | null
  replay_hash: Buffer | null
}

/**
 * `POST /v1/events` — idempotent intake (DESIGN section 5). The event and
 * one delivery per matching enabled endpoint are created in ONE statement:
 * a producer retry either sees a fresh insert or, after blocking on the
 * unique index, the committed original — never a partial event.
 */
export function eventsRouter(pool: Pool, options: IntakeOptions): Router {
  const router = Router()
  const limiter = new TokenBucket(options.burst, options.ratePerMinute)

  router.post('/events', async (req: Request, res: Response) => {
    const context = req.tenant
    if (!context) throw new Error('auth middleware did not attach a tenant')

    const verdict = limiter.tryTake(context.tenantId)
    if (!verdict.allowed) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many events, slow down', {
        'Retry-After': String(verdict.retryAfterSeconds),
      })
    }

    const header = req.get('Idempotency-Key')
    const idempotencyKey = typeof header === 'string' ? header.trim() : ''
    if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Idempotency-Key header must be 1..200 characters',
      )
    }

    const body = parseBody(intakeSchema, req.body)
    const encoded = Buffer.from(canonicalJson(body.payload), 'utf8')
    if (encoded.length > MAX_PAYLOAD_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'payload exceeds 256 KB')
    }
    const requestHash = createHash('sha256')
      .update(canonicalJson({ eventType: body.eventType, payload: body.payload }), 'utf8')
      .digest()

    const result = await pool.query<IntakeResultRow>(
      `WITH ev AS (
         INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id
       ),
       existing AS (
         SELECT e.id AS event_id,
                e.request_hash,
                (SELECT count(*) FROM deliveries d WHERE d.event_id = e.id) AS deliveries
         FROM events e
         WHERE e.tenant_id = $1 AND e.idempotency_key = $4 AND NOT EXISTS (SELECT 1 FROM ev)
       ),
       fresh AS (
         INSERT INTO deliveries (event_id, endpoint_id)
         SELECT ev.id, ep.id
         FROM ev
         JOIN endpoints ep ON ep.tenant_id = $1
          AND ep.status = 'enabled'
          AND ('*' = ANY(ep.event_types) OR $2 = ANY(ep.event_types))
         RETURNING 1
       )
       SELECT (SELECT id FROM ev)                    AS new_event_id,
              (SELECT count(*) FROM fresh)           AS new_deliveries,
              (SELECT event_id FROM existing)        AS replay_event_id,
              (SELECT deliveries FROM existing)      AS replay_deliveries,
              (SELECT request_hash FROM existing)    AS replay_hash`,
      [context.tenantId, body.eventType, canonicalJson(body.payload), idempotencyKey, requestHash],
    )
    const row = result.rows[0]
    if (!row) throw new AppError(500, 'INTERNAL', 'Intake returned no result')

    if (row.new_event_id !== null) {
      res.status(202).json({ id: row.new_event_id, deliveries: Number(row.new_deliveries) })
      return
    }

    // A blocked conflict: our statement's snapshot predates the first
    // submission's commit, so the `existing` CTE saw nothing. The row must
    // exist by now (our insert conflicted with it), so re-read it with a
    // fresh snapshot.
    let resolved = row
    if (resolved.replay_event_id === null) {
      const follow = await pool.query<{
        id: string
        request_hash: Buffer
        deliveries: string
      }>(
        `SELECT e.id, e.request_hash,
                (SELECT count(*) FROM deliveries d WHERE d.event_id = e.id) AS deliveries
         FROM events e
         WHERE e.tenant_id = $1 AND e.idempotency_key = $2`,
        [context.tenantId, idempotencyKey],
      )
      const found = follow.rows[0]
      if (!found) throw new AppError(500, 'INTERNAL', 'Replay resolved to no event')
      resolved = {
        new_event_id: null,
        new_deliveries: '0',
        replay_event_id: found.id,
        replay_deliveries: found.deliveries,
        replay_hash: found.request_hash,
      }
    }

    const replayId = resolved.replay_event_id
    if (replayId === null) throw new AppError(500, 'INTERNAL', 'Replay resolved to no event')

    const replayHash = resolved.replay_hash
    if (replayHash === null || !replayHash.equals(requestHash)) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used with a different request',
      )
    }
    res
      .status(202)
      .set('Idempotent-Replayed', 'true')
      .json({ id: replayId, deliveries: Number(resolved.replay_deliveries ?? 0) })
  })

  // GET /v1/events/:id — the event and its deliveries (tenant-scoped).
  router.get('/events/:id', async (req: Request, res: Response) => {
    const context = req.tenant
    if (!context) throw new Error('auth middleware did not attach a tenant')
    const raw = req.params['id']
    const id = typeof raw === 'string' ? raw : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Event not found')

    const result = await pool.query<{
      id: string
      event_type: string
      payload: unknown
      idempotency_key: string
      created_at: Date
      delivery_id: string | null
      endpoint_id: string | null
      delivery_status: 'pending' | 'succeeded' | 'dead' | null
      attempt_count: number | null
      next_attempt_at: Date | null
      completed_at: Date | null
    }>(
      `SELECT e.id, e.event_type, e.payload, e.idempotency_key, e.created_at,
              d.id AS delivery_id, d.endpoint_id, d.status AS delivery_status,
              d.attempt_count, d.next_attempt_at, d.completed_at
       FROM events e
       LEFT JOIN deliveries d ON d.event_id = e.id
       WHERE e.id = $1 AND e.tenant_id = $2
       ORDER BY d.created_at`,
      [id, context.tenantId],
    )
    const first = result.rows[0]
    if (!first) throw new AppError(404, 'NOT_FOUND', 'Event not found')

    res.json({
      event: {
        id: first.id,
        eventType: first.event_type,
        payload: first.payload,
        idempotencyKey: first.idempotency_key,
        createdAt: first.created_at.toISOString(),
      },
      deliveries: result.rows
        .filter((row) => row.delivery_id !== null)
        .map((row) => ({
          id: row.delivery_id,
          endpointId: row.endpoint_id,
          status: row.delivery_status,
          attemptCount: row.attempt_count,
          nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
          completedAt: row.completed_at?.toISOString() ?? null,
        })),
    })
  })

  return router
}
