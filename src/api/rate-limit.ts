export interface TakeVerdict {
  allowed: boolean
  /** Seconds until a retry is reasonable; 0 when allowed. */
  retryAfterSeconds: number
}

/**
 * Per-tenant token bucket (DESIGN section 9). In-memory in v1: per API
 * instance; a Redis-backed limiter is a stretch goal (DESIGN section 15).
 * `now` is injectable so tests can advance time without real sleeps.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; last: number }>()

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(key: string, cost = 1): TakeVerdict {
    const t = this.now()
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, last: t }
      this.buckets.set(key, bucket)
    }
    const elapsed = Math.max(0, t - bucket.last)
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + (elapsed / 60_000) * this.refillPerMinute,
    )
    bucket.last = t
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost
      return { allowed: true, retryAfterSeconds: 0 }
    }
    const refillPerMs = this.refillPerMinute / 60_000
    const seconds = refillPerMs > 0 ? Math.ceil((cost - bucket.tokens) / refillPerMs / 1000) : 60
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.min(seconds, 60)) }
  }
}
