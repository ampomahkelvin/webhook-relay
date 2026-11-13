import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { Pool } from 'pg'
import { AppError, parseBody } from '../errors.js'
import { TokenBucket } from '../rate-limit.js'
import { canonicalJson } from '../../util/canonical-json.js'
import { isUuid } from '../../util/uuid.js'
import type { Metrics } from '../../observability/metrics.js'
import { requireTenantContext } from '../auth/tenant-auth.js'
import {
  EVENT_TYPE_PATTERN,
  MAX_EVENT_TYPE_LENGTH,
  MAX_PAYLOAD_BYTES,
} from '../../domain/vocabulary.js'
import { getEvent, requestHash, resolveReplay, submitIntake } from '../../db/events.js'
import { listDeliveriesForEvent } from '../../db/deliveries.js'
import { deliveryJson, eventJson } from '../serialize.js'

export interface IntakeOptions {
  ratePerMinute: number
  burst: number
  /** Optional observability hooks (DESIGN section 11). */
  metrics?: Metrics
}

const intakeSchema = z.object({
  eventType: z
    .string()
    .regex(EVENT_TYPE_PATTERN, 'must be lowercase a-z/0-9 words joined by . _ or -')
    .max(MAX_EVENT_TYPE_LENGTH),
  payload: z.record(z.string(), z.unknown()),
})

/**
 * `POST /v1/events` — idempotent intake (DESIGN section 5); the event and
 * its deliveries are created in one statement by the events data module.
 * `GET /v1/events/:id` — the event and its deliveries (tenant-scoped).
 */
export function eventsRouter(pool: Pool, options: IntakeOptions): Router {
  const router = Router()
  const limiter = new TokenBucket(options.burst, options.ratePerMinute)

  router.post('/events', async (req: Request, res: Response) => {
    const context = requireTenantContext(req)

    const verdict = limiter.tryTake(context.tenantId)
    if (!verdict.allowed) {
      options.metrics?.intakeRateLimited()
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
    const payloadJson = canonicalJson(body.payload)
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `payload exceeds ${MAX_PAYLOAD_BYTES / 1024} KB`)
    }

    const { result } = await submitIntake(pool, {
      tenantId: context.tenantId,
      eventType: body.eventType,
      payloadJson,
      idempotencyKey,
    })
    if (!result) throw new AppError(500, 'INTERNAL', 'Intake returned no result')

    if (result.new_event_id !== null) {
      options.metrics?.eventReceived()
      res.status(202).json({ id: result.new_event_id, deliveries: Number(result.new_deliveries) })
      return
    }

    // A blocked conflict: our statement's snapshot predates the first
    // submission's commit, so the replay path saw nothing. The row must
    // exist by now (our insert conflicted with it); re-read it fresh.
    let resolved = result
    if (resolved.replay_event_id === null) {
      const found = await resolveReplay(pool, { tenantId: context.tenantId, idempotencyKey })
      if (!found) throw new AppError(500, 'INTERNAL', 'Replay resolved to no event')
      resolved = {
        new_event_id: null,
        new_deliveries: '0',
        replay_event_id: found.eventId,
        replay_deliveries: String(found.deliveries),
        replay_hash: found.requestHash,
      }
    }

    const replayId = resolved.replay_event_id
    if (replayId === null) throw new AppError(500, 'INTERNAL', 'Replay resolved to no event')

    if (
      resolved.replay_hash === null ||
      !resolved.replay_hash.equals(requestHash(body.eventType, body.payload))
    ) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used with a different request',
      )
    }
    res
      .status(202)
      .set('Idempotent-Replayed', 'true')
      .json({
        id: replayId,
        deliveries: Number(resolved.replay_deliveries ?? 0),
      })
    // No eventReceived() here: this is a REPLAY of an event that was
    // already counted at intake, not a new one.
  })

  router.get('/events/:id', async (req: Request, res: Response) => {
    const context = requireTenantContext(req)
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Event not found')

    const event = await getEvent(pool, { eventId: id, tenantId: context.tenantId })
    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found')
    const deliveries = await listDeliveriesForEvent(pool, {
      tenantId: context.tenantId,
      eventId: id,
    })

    res.json({ event: eventJson(event), deliveries: deliveries.map((row) => deliveryJson(row)) })
  })

  return router
}
