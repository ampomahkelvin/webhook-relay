import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { Pool } from 'pg'
import { AppError } from '../errors.js'
import { decodeCursor, listQuerySchema, paginate } from '../pagination.js'
import { attemptJson, deliveryJson } from '../serialize.js'
import { requireTenantContext } from '../../auth/tenant-auth.js'
import { isUuid } from '../../util/uuid.js'
import {
  getDelivery,
  listAttempts,
  listDeliveryPage,
  replayDelivery,
} from '../../db/deliveries.js'
import { DELIVERY_STATUSES, type DeliveryStatus } from '../../db/vocabulary.js'

/**
 * Delivery operations (DESIGN section 10): the tenant-facing read side of
 * the queue plus replay. Deliveries belong to events, so tenant scope is a
 * join away — handled inside the data-access module; another tenant's ids
 * are plain 404s here.
 */

const filtersSchema = z.object({
  endpointId: z
    .string()
    .refine((value) => isUuid(value), { message: 'must be a UUID' })
    .optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  eventId: z
    .string()
    .refine((value) => isUuid(value), { message: 'must be a UUID' })
    .optional(),
})

export function deliveriesRouter(pool: Pool): Router {
  const router = Router()

  // GET /deliveries — filtered, cursor-paginated (newest first).
  router.get('/deliveries', async (req: Request, res: Response) => {
    const query = listQuerySchema.safeParse(req.query)
    if (!query.success) {
      const details = query.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid query parameters: ${details}`)
    }
    const filters = filtersSchema.safeParse(req.query)
    if (!filters.success) {
      const details = filters.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid query parameters: ${details}`)
    }

    const rows = await listDeliveryPage(pool, {
      tenantId: requireTenantContext(req).tenantId,
      cursor: decodeCursor(query.data.cursor),
      limit: query.data.limit,
      filters: filters.data,
    })
    const { page, nextCursor } = paginate(rows, query.data.limit)
    res.json({ items: page.map((row) => deliveryJson(row)), nextCursor })
  })

  // GET /deliveries/:id — the delivery plus its append-only attempt log.
  router.get('/deliveries/:id', async (req: Request, res: Response) => {
    const raw = req.params['id']
    const id = typeof raw === 'string' ? raw : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')

    const row = await getDelivery(pool, {
      deliveryId: id,
      tenantId: requireTenantContext(req).tenantId,
    })
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')

    const attempts = await listAttempts(pool, id)
    res.json({
      delivery: deliveryJson(row),
      attempts: attempts.map((attempt) => attemptJson(attempt)),
    })
  })

  // POST /deliveries/:id/replay — only a settled delivery may replay; the
  // data-access module owns the cycle_start convention, this route just
  // translates the refusal reason into a status code.
  router.post('/deliveries/:id/replay', async (req: Request, res: Response) => {
    const raw = req.params['id']
    const id = typeof raw === 'string' ? raw : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')

    const outcome = await replayDelivery(pool, {
      deliveryId: id,
      tenantId: requireTenantContext(req).tenantId,
    })
    if (outcome.ok) {
      res.status(202).json({ delivery: deliveryJson(outcome.delivery) })
      return
    }

    // Distinguish not-found/not-owned from a still-settling delivery.
    const state = outcome.state
    if (!state) throw new AppError(404, 'NOT_FOUND', 'Delivery not found')
    if (state.locked_until !== null) {
      throw new AppError(
        409,
        'DELIVERY_IN_FLIGHT',
        'Delivery is leased to a worker; replay once it settles',
      )
    }
    throw new AppError(
      409,
      'NOT_REPLAYABLE',
      `Delivery is ${state.status}; only dead or succeeded deliveries can be replayed`,
    )
  })

  return router
}
