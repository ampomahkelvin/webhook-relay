import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { AppError } from '../api/errors.js'
import { bearerToken, type AuthMiddleware } from './bearer.js'

function secureEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/** Gate for the admin namespace; requires the exact admin key from configuration. */
export function requireAdminKey(adminApiKey: string): AuthMiddleware {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = bearerToken(req)
    if (token === undefined || !secureEqual(token, adminApiKey)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid admin key')
    }
    next()
  }
}
