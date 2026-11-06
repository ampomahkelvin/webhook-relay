import type { Pool } from 'pg'
import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../api/errors.js'
import { hashApiKey } from './api-keys.js'
import { bearerToken } from './bearer.js'
import type { AuthMiddleware } from './bearer.js'

export interface TenantContext {
  tenantId: string
  tenantName: string
}

/**
 * Gate for tenant-scoped routes. Resolves the bearer API key to its
 * (unrevoked) tenant and attaches the tenant context to the request.
 * Tenant routes never say 403; unknown or revoked keys are 401 here and
 * cross-tenant resources are 404 at the resource level.
 */
export function requireTenantContext(req: Request): TenantContext {
  const context = req.tenant
  if (!context) throw new Error('auth middleware did not attach a tenant')
  return context
}

export function requireTenantAuth(pool: Pool): AuthMiddleware {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = bearerToken(req)
      if (token === undefined) {
        throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token')
      }
      const result = await pool.query<{
        tenant_id: string
        name: string
      }>(
        `SELECT k.tenant_id, t.name
         FROM api_keys k
         JOIN tenants t ON t.id = k.tenant_id
         WHERE k.key_hash = $1 AND k.revoked_at IS NULL
         LIMIT 1`,
        [hashApiKey(token)],
      )
      const row = result.rows[0]
      if (!row) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid or revoked API key')
      }
      req.tenant = { tenantId: row.tenant_id, tenantName: row.name }
      next()
    } catch (error) {
      next(error)
    }
  }
}
