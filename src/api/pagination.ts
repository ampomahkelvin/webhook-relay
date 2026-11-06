import { z } from 'zod'
import { AppError } from './errors.js'
import { isUuid } from '../util/uuid.js'

/**
 * Tenant list routes share one pagination contract (DESIGN section 10):
 * a base64url `(createdAt, id)` tuple, newest first, keyset-paginated.
 * Queries fetch LIMIT n+1 and translate the extra row into the next
 * cursor with this shared machinery. The tuple columns are written once
 * at creation and never change in place, so an UPDATE moving rows cannot
 * destabilize a page.
 */

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).optional(),
})

export interface CursorParts {
  createdAt: string
  id: string
}

/** The strings the keyset clause compares against; null when page 1. */
export function decodeCursor(cursor: string | undefined): CursorParts | null {
  if (cursor === undefined) return null
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      typeof decoded?.createdAt !== 'string' ||
      typeof decoded?.id !== 'string' ||
      !isUuid(decoded.id)
    ) {
      throw new Error('bad cursor')
    }
    return { createdAt: decoded.createdAt, id: decoded.id }
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor')
  }
}

/** The two query parameters the keyset clause always binds, in order. */
export function cursorParams(cursor: CursorParts | null): Array<string | null> {
  return [cursor?.createdAt ?? null, cursor?.id ?? null]
}

interface PageRow {
  created_at: Date
  id: string
}

/** Split an over-fetched result (LIMIT n+1) into the page plus next cursor. */
export function paginate<T extends PageRow>(
  rows: T[],
  limit: number,
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id }),
        ).toString('base64url')
      : null
  return { page, nextCursor }
}
