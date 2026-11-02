import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { Pool } from 'pg'
import { AppError } from '../errors.js'
import { isUuid } from '../../util/uuid.js'
import type { TenantContext } from '../../auth/tenant-auth.js'

/**
 * Delivery operations (DESIGN section 10): the tenant-facing read side of
 * the queue plus replay. Deliveries belong to events, so every query is
 * scoped by joining `events` on the tenant; another tenant's ids are
 * plain 404s.
 */

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
  endpointId: z
    .string()
    .refine((value) => isUuid(value), { message: 'must be a UUID' })
    .optional(),
  status: z.enum(['pending', 'succeeded', 'dead']).optional(),
  eventId: z
    .string()
    .refine((value) => isUuid(value), { message: 'must be a UUID' })
    .optional(),
})

interface DeliveryRow {
  id: string
  event_id: string
  endpoint_id: string
  status: 'pending' | 'succeeded' | 'dead'
  attempt_count: number
  cycle_start: number
  next_attempt_at: Date
  locked_until: Date | null
  completed_at: Date | null
  created_at: Date
}

interface AttemptRow {
  attempt_number: number
  started_at: Date
  duration_ms: number
  status_code: number | null
  error_kind: string | null
  response_snippet: string | null
}

export function deliveriesRouter(pool: Pool): Router {
  const router = Router()

  const tenant = (req: Request): TenantContext => {
    const context = req.tenant
    if (!context) throw new Error('auth middleware did not attach a tenant')
    return context
  }

  const deliveryJson = (row: DeliveryRow) => ({
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    status: row.status,
    attemptCount: row.attempt_count,
    cycleStart: row.cycle_start,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    lockedUntil: row.locked_until?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  })

  // GET /deliveries — filtered, cursor-paginated (newest first). The cursor
  // is the same base64url (createdAt, id) tuple the endpoints list uses;
  // instability from an UPDATE moving rows is not a concern: the tuple
  // columns are written once at creation and never change in place.
  router.get('/deliveries', async (req: Request, res: Response) => {
    const query = listQuerySchema.safeParse(req.query)
    if (!query.success) {
      const details = query.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid query parameters: ${details}`)
    }
    const { limit, cursor, endpointId, status, eventId } = query.data

    let cursorParts: { createdAt: string; id: string } | null = null
    if (cursor !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (
          typeof decoded?.createdAt !== 'string' ||
          typeof decoded?.id !== 'string' ||
          !isUuid(decoded.id)
        ) {
          throw new Error('bad cursor')
        }
        cursorParts = { createdAt: decoded.createdAt, id: decoded.id }
      } catch {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor')
      }
    }

    const result = await pool.query<DeliveryRow>(
      `SELECT d.id, d.event_id, d.endpoint_id, d.status::text AS status, d.attempt_count,
              d.cycle_start, d.next_attempt_at, d.locked_until, d.completed_at, d.created_at
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       WHERE e.tenant_id = $1
         AND ($2::timestamptz IS NULL OR (d.created_at, d.id) < ($2::timestamptz, $3::uuid))
         AND ($4::uuid IS NULL OR d.endpoint_id = $4::uuid)
         AND ($5::delivery_status IS NULL OR d.status = $5::delivery_status)
         AND ($6::uuid IS NULL OR d.event_id = $6::uuid)
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT $7`,
      [
        tenant(req).tenantId,
        cursorParts?.createdAt ?? null,
        cursorParts?.id ?? null,
        endpointId ?? null,
        status ?? null,
        eventId ?? null,
        limit + 1,
      ],
    )
    const rows = result.rows
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id }),
          ).toString('base64url')
        : null
    res.json({ items: page.map((row) => deliveryJson(row)), nextCursor })
  })

  // GET /deliveries/:id — the delivery plus its append-only attempt log.
  router.get('/deliveries/:id', async (req: Request, res: Response) => {
    const raw = req.params['id']
    const id = typeof raw === 'string' ? raw : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')

    const result = await pool.query<DeliveryRow>(
      `SELECT d.id, d.event_id, d.endpoint_id, d.status::text AS status, d.attempt_count,
              d.cycle_start, d.next_attempt_at, d.locked_until, d.completed_at, d.created_at
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       WHERE d.id = $1 AND e.tenant_id = $2`,
      [id, tenant(req).tenantId],
    )
    const row = result.rows[0]
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')

    const attempts = await pool.query<AttemptRow>(
      `SELECT attempt_number, started_at, duration_ms, status_code, error_kind,
              response_snippet
       FROM delivery_attempts
       WHERE delivery_id = $1
       ORDER BY attempt_number`,
      [id],
    )

    res.json({
      delivery: deliveryJson(row),
      attempts: attempts.rows.map((attempt) => ({
        attemptNumber: attempt.attempt_number,
        startedAt: attempt.started_at.toISOString(),
        durationMs: attempt.duration_ms,
        statusCode: attempt.status_code,
        errorKind: attempt.error_kind,
        responseSnippet: attempt.response_snippet,
      })),
    })
  })

  // POST /deliveries/:id/replay — only a settled delivery may replay. One
  // UPDATE flips it back into the queue: status pending, due now, lease
  // cleared, and `cycle_start = attempt_count` so the retry schedule
  // restarts at index 0 WITHOUT renumbering the attempt history (fencing
  // and the UNIQUE (delivery_id, attempt_number) stay intact).
  router.post('/deliveries/:id/replay', async (req: Request, res: Response) => {
    const raw = req.params['id']
    const id = typeof raw === 'string' ? raw : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')

    const settled = await pool.query<DeliveryRow>(
      `UPDATE deliveries d
       SET status = 'pending', next_attempt_at = now(), completed_at = NULL,
           locked_until = NULL, cycle_start = d.attempt_count
       FROM events e
       WHERE d.id = $1 AND e.id = d.event_id AND e.tenant_id = $2
         AND d.status IN ('dead', 'succeeded')
         AND d.locked_until IS NULL
       RETURNING d.id, d.event_id, d.endpoint_id, d.status::text AS status,
                 d.attempt_count, d.cycle_start, d.next_attempt_at, d.locked_until,
                 d.completed_at, d.created_at`,
      [id, tenant(req).tenantId],
    )
    const row = settled.rows[0]
    if (!row) {
      // Distinguish not-found/not-owned from a still-settling delivery.
      const existing = await pool.query<{ status: string; locked_until: Date | null }>(
        `SELECT DISTINCT d.status::text AS status, d.locked_until
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         WHERE d.id = $1 AND e.tenant_id = $2`,
        [id, tenant(req).tenantId],
      )
      const found = existing.rows[0]
      if (!found) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')
      if (found.locked_until !== null) {
        throw new AppError(
          409,
          'DELIVERY_IN_FLIGHT',
          'Delivery is leased to a worker; replay once it settles',
        )
      }
      throw new AppError(
        409,
        'NOT_REPLAYABLE',
        `Delivery is ${found.status}; only dead or succeeded deliveries can be replayed`,
      )
    }
    res.status(202).json({ delivery: deliveryJson(row) })
  })

  return router
}
