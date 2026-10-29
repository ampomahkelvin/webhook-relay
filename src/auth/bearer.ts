import type { NextFunction, Request, Response } from 'express'

/** Extract the bearer token, or undefined when the header is missing/malformed/empty. */
export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : undefined
}

export type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void
