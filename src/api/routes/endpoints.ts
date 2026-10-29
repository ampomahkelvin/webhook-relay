import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { Pool } from 'pg'
import { AppError, parseBody } from '../errors.js'
import { isUuid } from '../../util/uuid.js'
import { createSigningSecret, encryptSecret } from '../../security/crypto.js'
import {
  InvalidEndpointUrlError,
  validateEndpointUrl,
} from '../../security/validate-endpoint-url.js'
import type { TenantContext } from '../../auth/tenant-auth.js'

export interface EndpointRouterOptions {
  maxEndpointsPerTenant: number
  /** Dev-only: allow `http://` receivers. Default false. */
  allowInsecureHttp?: boolean
  /** Base64 ENCRYPTION_KEY for the signing-secret store. */
  encryptionKey: string
}

const eventTypeName = z.string().regex(/^\*|^[a-z0-9]+([._-][a-z0-9]+)*$/, {
  message: "must be '*' or a lowercase a-z/0-9/. _ - name",
})

const createEndpointSchema = z.object({
  url: z.string().min(1).max(2048),
  description: z.string().trim().min(1).max(500).optional(),
  eventTypes: z.array(eventTypeName).min(1).max(50),
})

const updateEndpointSchema = z
  .object({
    url: z.string().min(1).max(2048).optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
    eventTypes: z.array(eventTypeName).min(1).max(50).optional(),
    status: z.enum(['enabled', 'disabled']).optional(),
  })
  .strict()

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
})

interface EndpointLike {
  id: string
  url: string
  description: string | null
  event_types: string[]
  status: 'enabled' | 'disabled'
  disabled_reason: 'manual' | 'gone' | 'failing' | null
  circuit_state?: 'closed' | 'open' | 'half_open'
  created_at: Date
  updated_at: Date
}

interface EndpointRow extends EndpointLike {
  circuit_state: 'closed' | 'open' | 'half_open'
  tenant_id: string
}

/**
 * Endpoint CRUD for tenants, mounted under the authenticated /v1 router.
 * Every query is scoped by tenant_id; another tenant's id is a plain 404.
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

  const tenant = (req: Request): TenantContext => {
    const context = req.tenant
    if (!context) throw new Error('auth middleware did not attach a tenant')
    return context
  }

  const requireOwnedEndpoint = async (req: Request): Promise<EndpointRow> => {
    const raw = req.params['id']
    const id = typeof raw === 'string' ? raw : ''
    if (!isUuid(id)) throw new AppError(404, 'NOT_FOUND', 'Endpoint not found')
    const result = await pool.query<EndpointRow>(
      `SELECT id, tenant_id, url, description, event_types, status, disabled_reason,
              circuit_state, created_at, updated_at
       FROM endpoints WHERE id = $1 AND tenant_id = $2`,
      [id, tenant(req).tenantId],
    )
    const row = result.rows[0]
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Endpoint not found')
    return row
  }

  const endpointJson = (row: EndpointLike) => ({
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types,
    status: row.status,
    disabledReason: row.disabled_reason,
    circuitState: row.circuit_state ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  })

  router.post('/endpoints', async (req: Request, res: Response) => {
    const body = parseBody(createEndpointSchema, req.body)
    if (body.eventTypes.includes('*') && body.eventTypes.length > 1) {
      throw new AppError(400, 'VALIDATION_ERROR', "eventTypes: '*' must be used alone")
    }
    const url = validateUrl(body.url)

    // Atomic cap enforcement: the INSERT only happens while the count is
    // below the limit, so intake fan-out stays bounded (DESIGN section 4).
    const secret = createSigningSecret()
    const result = await pool.query<EndpointLike>(
      `INSERT INTO endpoints (tenant_id, url, description, event_types, secret_ciphertext)
       SELECT $1, $2, $3, $4::text[], $5
       WHERE (SELECT count(*) FROM endpoints WHERE tenant_id = $1) < $6
       RETURNING id, created_at, url, description, event_types,
                 status, disabled_reason, updated_at`,
      [
        tenant(req).tenantId,
        url,
        body.description ?? null,
        body.eventTypes,
        encryptSecret(secret, encryptionKey),
        options.maxEndpointsPerTenant,
      ],
    )
    const row = result.rows[0]
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

    const result = await pool.query<EndpointRow>(
      `SELECT id, tenant_id, url, description, event_types, status, disabled_reason,
              circuit_state, created_at, updated_at
       FROM endpoints
       WHERE tenant_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [tenant(req).tenantId, cursorParts?.createdAt ?? null, cursorParts?.id ?? null, limit + 1],
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
    res.json({ items: page.map((row) => endpointJson(row)), nextCursor })
  })

  router.get('/endpoints/:id', async (req: Request, res: Response) => {
    const row = await requireOwnedEndpoint(req)
    // Breaker state is visible to the tenant (DESIGN section 7).
    res.json({ endpoint: endpointJson(row) })
  })

  router.patch('/endpoints/:id', async (req: Request, res: Response) => {
    const body = parseBody(updateEndpointSchema, req.body)
    const current = await requireOwnedEndpoint(req)

    const url = body.url !== undefined ? validateUrl(body.url) : current.url
    const eventTypes = body.eventTypes ?? current.event_types
    const status = body.status ?? current.status
    if (eventTypes.includes('*') && eventTypes.length > 1) {
      throw new AppError(400, 'VALIDATION_ERROR', "eventTypes: '*' must be used alone")
    }

    // DB constraint: status='disabled' ⇔ disabled_reason IS NOT NULL.
    const disabledReason = status === 'disabled' ? (current.disabled_reason ?? 'manual') : null

    const result = await pool.query<EndpointRow>(
      `UPDATE endpoints
       SET url = $1, description = $2, event_types = $3::text[], status = $4,
           disabled_reason = $5, updated_at = now()
       WHERE id = $6 AND tenant_id = $7
       RETURNING id, tenant_id, url, description, event_types, status, disabled_reason,
                 circuit_state, created_at, updated_at`,
      [
        url,
        body.description === undefined ? current.description : body.description,
        eventTypes,
        status,
        disabledReason,
        current.id,
        tenant(req).tenantId,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new AppError(500, 'INTERNAL', 'Update did not apply')
    res.json({ endpoint: endpointJson(row) })
  })

  router.delete('/endpoints/:id', async (req: Request, res: Response) => {
    const current = await requireOwnedEndpoint(req)
    // Deliveries for this endpoint cascade-delete (DESIGN section 10).
    await pool.query('DELETE FROM endpoints WHERE id = $1 AND tenant_id = $2', [
      current.id,
      tenant(req).tenantId,
    ])
    res.status(204).end()
  })

  // POST /v1/endpoints/:id/test arrives in phase 7, once dispatch exists.

  return router
}
