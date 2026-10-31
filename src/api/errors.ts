import type { NextFunction, Request, Response } from 'express'
import type { Logger } from '../logger.js'

/** Typed error with the exact `{ code, message }` API shape. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/** Validate a request body against a Zod schema, or throw 400. */
export function parseBody<T>(
  schema: {
    safeParse: (input: unknown) =>
      | {
          success: false
          error: { issues: Array<{ path: (string | number | symbol)[]; message: string }> }
        }
      | { success: true; data: T }
  },
  body: unknown,
): T {
  const result = schema.safeParse(body)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid request body: ${details}`)
  }
  return result.data
}

/**
 * Global error handler. Maps:
 * - AppError → its own status/code
 * - Postgres unique violations → 409 CONFLICT
 * - anything else → 500 INTERNAL (message never leaked)
 */
export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) {
      res.end()
      return
    }
    if (error instanceof AppError) {
      if (error.status >= 500) logger.error({ err: error, requestId: req.id }, 'app error')
      else logger.info({ code: error.code, requestId: req.id }, error.message)
      for (const [name, value] of Object.entries(error.headers)) res.set(name, value)
      res.status(error.status).json({ code: error.code, message: error.message })
      return
    }
    const pgCode = (error as { code?: string } | null)?.code
    if (pgCode === '23505') {
      logger.info({ requestId: req.id, pgCode }, 'unique violation')
      res.status(409).json({ code: 'CONFLICT', message: 'Resource already exists' })
      return
    }
    logger.error({ err: error, requestId: req.id }, 'unhandled error')
    res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' })
  }
}
