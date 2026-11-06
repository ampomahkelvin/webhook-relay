import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { AppError, parseBody } from '../errors.js'
import { decodeCursor, listQuerySchema, paginate } from '../pagination.js'
import { endpointJson } from '../serialize.js'
import { requireTenantContext } from '../../auth/tenant-auth.js'
import { isUuid } from '../../util/uuid.js'
import { createSigningSecret, encryptSecret } from '../../security/crypto.js'
import {
  InvalidEndpointUrlError,
  validateEndpointUrl,
} from '../../security/validate-endpoint-url.js'
import { canonicalJson } from '../../util/canonical-json.js'
import {
  createEndpoint,
  deleteEndpoint,
  getOwnedEndpoint,
  listEndpointPage,
  updateEndpoint,
} from '../../db/endpoints.js'
import { insertEventWithSingleDelivery } from '../../db/events.js'
import { EVENT_TYPE_PATTERN, MAX_EVENT_TYPE_LENGTH, WILDCARD_EVENT_TYPE } from '../../db/vocabulary.js'

export interface EndpointRouterOptions {
  maxEndpointsPerTenant: number
  /** Dev-only: allow `http://` receivers. Default false. */
  allowInsecureHttp?: boolean
  /** Base64 ENCRYPTION_KEY for the signing-secret store. */
  encryptionKey: string
}

const eventTypeName = z
  .string()
  .max(MAX_EVENT_TYPE_LENGTH)
  .refine(
    (value) => value === WILDCARD_EVENT_TYPE || EVENT_TYPE_PATTERN.test(value),
    { message: "must be '*' or a lowercase a-z/0-9/. _ - name" },
  )

const createEndpointSchema = z
  .object({
    url: z.string().min(1).max(2048),
    description: z.string().trim().min(1).max(500).optional(),
    eventTypes: z.array(eventTypeName).min(1).max(50),
  })
  .strict()

const updateEndpointSchema = z
  .object({
    url: z.string().min(1).max(2048).optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
    eventTypes: z.array(eventTypeName).min(1).max(50).optional(),
    status: z.enum(['enabled', 'disabled']).optional(),
  })
  .strict()

/**
 * The wildcard subscription matches every event type, so it can only
 * mean that — one event type per endpoint or a name list, never both
 * (an invariant the intake SQL's OR-matcher quietly depends on).
 */
function assertWildcardAlone(eventTypes: string[]): void {
  if (eventTypes.includes(WILDCARD_EVENT_TYPE) && eventTypes.length > 1) {
    throw new AppError(400, 'VALIDATION_ERROR', `eventTypes: '*' must be used alone`)
  }
}

/**
 * Endpoint CRUD for tenants, mounted under the authenticated /v1 router.
 * Ownership lives in the data-access module: another tenant's id is a
 * plain 404.
 */
export function endpointRouter(pool: Pool, options: EndpointRouterOptions): Router {
  const router = Router()
  const encryptionKey = Buffer.from(options.encryptionKey, 'base64')

  const validateUrl = (raw: string): string => {
    try {
      return validateEndpointUrl(raw, { allowInsecureHttp: options.allowInsecureHttp })
    } catch (error) {
      if (error instanceof InvalidEndpointUrlError) {
        throw new AppError(400, 'VALIDATION_ERROR', `url: ${error.message}`)
      }
      throw error
    }
  }

  const requireOwnedEndpoint = async (req: Request) => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Endpoint not found')
    const row = await getOwnedEndpoint(pool, {
      tenantId: requireTenantContext(req).tenantId,
      endpointId: id,
    })
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Endpoint not found')
    return row
  }

  router.post('/endpoints', async (req: Request, res: Response) => {
    const body = parseBody(createEndpointSchema, req.body)
    assertWildcardAlone(body.eventTypes)
    const url = validateUrl(body.url)

    const secret = createSigningSecret()
    const row = await createEndpoint(pool, {
      tenantId: requireTenantContext(req).tenantId,
      url,
      description: body.description ?? null,
      eventTypes: body.eventTypes,
      secretCiphertext: encryptSecret(secret, encryptionKey),
      maxPerTenant: options.maxEndpointsPerTenant,
    })
    if (!row) throw new AppError(409, 'ENDPOINT_LIMIT_REACHED', 'Endpoint limit reached')

    res.status(201).json({
      endpoint: endpointJson(row),
      // The full signing secret is returned exactly once, at creation.
      signingSecret: secret,
    })
  })

  router.get('/endpoints', async (req: Request, res: Response) => {
    const query = listQuerySchema.safeParse(req.query)
    if (!query.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters')
    const { limit, cursor } = query.data
    const decoded = decodeCursor(cursor)

    const rows = await listEndpointPage(pool, {
      tenantId: requireTenantContext(req).tenantId,
      cursor: decoded,
      limit,
    })
    const { page, nextCursor } = paginate(rows, limit)
    res.json({ items: page.map((row) => endpointJson(row)), nextCursor })
  })

  // Breaker state is visible to the tenant (DESIGN section 7).
  router.get('/endpoints/:id', async (req: Request, res: Response) => {
    const row = await requireOwnedEndpoint(req)
    res.json({ endpoint: endpointJson(row) })
  })

  router.patch('/endpoints/:id', async (req: Request, res: Response) => {
    const body = parseBody(updateEndpointSchema, req.body)
    const current = await requireOwnedEndpoint(req)
    assertWildcardAlone(body.eventTypes ?? current.event_types)

    // DB constraint: status='disabled' ⇔ disabled_reason IS NOT NULL.
    const disabledReason = (body.status ?? current.status) === 'disabled'
      ? current.disabled_reason ?? 'manual'
      : null

    const row = await updateEndpoint(pool, {
      tenantId: requireTenantContext(req).tenantId,
      endpointId: current.id,
      patch: {
        url: body.url !== undefined ? validateUrl(body.url) : current.url,
        description: body.description === undefined ? current.description : body.description,
        eventTypes: body.eventTypes ?? current.event_types,
        status: body.status ?? current.status,
        disabledReason,
      },
    })
    res.json({ endpoint: endpointJson(row) })
  })

  router.delete('/endpoints/:id', async (req: Request, res: Response) => {
    const current = await requireOwnedEndpoint(req)
    await deleteEndpoint(pool, {
      tenantId: requireTenantContext(req).tenantId,
      endpointId: current.id,
    })
    res.status(204).end()
  })

  // POST /v1/endpoints/:id/test — a `webhook.test` event fanned out to
  // this endpoint only (DESIGN section 10), riding the normal dispatcher
  // path: one event + one delivery in a single statement, no side-channel
  // send. A disabled endpoint gets nothing to receive (409).
  router.post('/endpoints/:id/test', async (req: Request, res: Response) => {
    const endpoint = await requireOwnedEndpoint(req)
    if (endpoint.status === 'disabled') {
      throw new AppError(409, 'ENDPOINT_DISABLED', 'Endpoint is disabled')
    }

    const payload = canonicalJson({ source: 'endpoint.test', sentAt: new Date().toISOString() })
    const created = await insertEventWithSingleDelivery(pool, {
      tenantId: requireTenantContext(req).tenantId,
      eventType: 'webhook.test',
      payloadJson: payload,
      // The key is unique forever, so an idempotent replay can never happen.
      idempotencyKey: `test-${randomUUID()}`,
      endpointId: endpoint.id,
    })
    if (!created) throw new AppError(500, 'INTERNAL', 'Test event did not apply')

    res.status(202).json({ id: created.eventId, deliveryId: created.deliveryId })
  })

  return router
}
