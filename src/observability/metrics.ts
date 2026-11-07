import type { Pool } from 'pg'
import { fetchQueueGauges, type QueueGauges } from '../db/deliveries.js'

/**
 * Prometheus text-format metrics with NO client library (DESIGN section
 * 11): counters, one histogram per observed latency, and the three queue
 * gauges recomputed from Postgres per scrape and cached 5 s.
 *
 * Counters/histograms live in process memory — like any Prometheus client
 * — so they reset on restart (Prometheus rates are computed from the
 * scraped series anyway) and sum across horizontal replicas. Gauges are
 * always derived from the database: they are properties of the queue, not
 * of any one process.
 */

const GAUGE_CACHE_MS = 5_000

const HISTOGRAM_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

/** Queue-gauge type alias for the Prometheus rendering layer below. */
export type DbGauges = QueueGauges

const escapeLabelValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')

/** `name{a="1",b="2"}` — labels sorted so series keys are deterministic. */
export function seriesKey(name: string, labels: Record<string, string> = {}): string {
  const pairs = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`
}

/** The bare metric name of a series key (used for HELP/TYPE lines). */
const metricName = (key: string): string => key.split('{')[0]!

const labelPart = (key: string): string => {
  const name = metricName(key)
  return key.length > name.length ? key.slice(name.length + 1, -1) : ''
}

export interface MetricsOptions {
  /** Injectable clock for the gauge cache in tests. */
  now?: () => number
}

export class Metrics {
  private counters = new Map<string, { value: number }>()
  private histograms = new Map<string, { counts: number[]; sum: number; total: number }>()
  private names = new Map<string, string>() // metric name -> help
  private cached: { at: number; gauges: DbGauges } | null = null
  private readonly now: () => number

  constructor(options: MetricsOptions = {}) {
    this.now = options.now ?? Date.now
  }

  counter(name: string, help: string, labels: Record<string, string> = {}, amount = 1): void {
    const key = seriesKey(name, labels)
    const existing = this.counters.get(key)
    this.names.set(name, help)
    if (existing) existing.value += amount
    else this.counters.set(key, { value: amount })
  }

  observe(name: string, help: string, seconds: number, labels: Record<string, string> = {}): void {
    const key = seriesKey(name, labels)
    this.names.set(name, help)
    let state = this.histograms.get(key)
    if (!state) {
      state = { counts: new Array<number>(HISTOGRAM_BUCKETS.length).fill(0), sum: 0, total: 0 }
      this.histograms.set(key, state)
    }
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
      if (seconds <= HISTOGRAM_BUCKETS[i]!) {
        state.counts[i]! += 1
        break
      }
    }
    state.sum += seconds
    state.total += 1
  }

  // --- Semantic metrics used across the three processes ---

  eventReceived(): void {
    this.counter('events_received_total', 'Accepted event submissions (intake, any 202)')
  }

  intakeRateLimited(): void {
    this.counter('intake_rate_limited_total', 'Intake submissions rejected with 429')
  }

  deliveryOutcome(outcome: 'succeeded' | 'retry' | 'dead'): void {
    this.counter('deliveries_total', 'Recorded delivery outcomes by this process', { outcome })
  }

  attemptDuration(seconds: number): void {
    this.observe(
      'delivery_attempt_duration_seconds',
      'Receiver attempt latency',
      Math.max(0, seconds),
    )
  }

  /** Serializes counters + histograms + database gauges (cached 5 s). */
  async render(pool?: Pool): Promise<string> {
    const lines: string[] = []
    const emitted = new Set<string>()

    const emitMetadata = (name: string, help: string, type: 'counter' | 'histogram') => {
      if (emitted.has(name)) return
      emitted.add(name)
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    }

    for (const [key, counter] of this.counters) {
      const name = metricName(key)
      emitMetadata(name, this.names.get(name)!, 'counter')
      lines.push(`${key} ${counter.value}`)
    }
    for (const [key, state] of this.histograms) {
      const name = metricName(key)
      emitMetadata(name, this.names.get(name)!, 'histogram')
      const rest = labelPart(key) === '' ? '' : `${labelPart(key)},`
      let cumulative = 0
      HISTOGRAM_BUCKETS.forEach((bucket, i) => {
        cumulative += state.counts[i]!
        lines.push(`${name}_bucket{${rest}le="${bucket}"} ${cumulative}`)
      })
      lines.push(
        `${name}_bucket{${rest}le="+Inf"} ${state.total}`,
        `${name}_sum{${labelPart(key)}} ${state.sum}`,
        `${name}_count{${labelPart(key)}} ${state.total}`,
      )
    }

    if (pool) {
      const age = this.now() - (this.cached?.at ?? 0)
      if (this.cached === null || age > GAUGE_CACHE_MS) {
        this.cached = { at: this.now(), gauges: await fetchQueueGauges(pool) }
      }
      const { deliveriesPending, oldestDueDeliveryAgeSeconds, endpointsCircuitOpen } =
        this.cached.gauges
      lines.push(
        '# HELP deliveries_pending Backlog: deliveries waiting to be claimed',
        '# TYPE deliveries_pending gauge',
        `deliveries_pending ${deliveriesPending}`,
        '# HELP oldest_due_delivery_age_seconds Delivery lag: age of the most overdue claimable delivery (0 when none due)',
        '# TYPE oldest_due_delivery_age_seconds gauge',
        `oldest_due_delivery_age_seconds ${oldestDueDeliveryAgeSeconds}`,
        '# HELP endpoints_circuit_open Unhealthy receivers: endpoints whose breaker is not closed',
        '# TYPE endpoints_circuit_open gauge',
        `endpoints_circuit_open ${endpointsCircuitOpen}`,
      )
    }
    return `${lines.join('\n')}\n`
  }
}
