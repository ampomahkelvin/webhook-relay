/**
 * The application's typed error. Pure domain: it carries the HTTP shape
 * (status, code, headers) but knows nothing about Express — the mapping to
 * a response lives in `src/api/errors.ts` (errorHandler). Living here
 * breaks the api <-> auth dependency cycle: auth middleware throws it, the
 * api layer renders it, and neither imports the other.
 */

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
