import { describe, expect, it } from 'vitest'
import { Metrics, seriesKey } from '../../src/observability/metrics.js'

/** The exposition format: correct HELP/TYPE grouping, escaping, buckets. */

describe('Metrics.render', () => {
  it('renders labeled counters with a single HELP/TYPE per metric', async () => {
    const metrics = new Metrics()
    metrics.counter('deliveries_total', 'Recorded delivery outcomes', { outcome: 'succeeded' })
    metrics.counter('deliveries_total', 'Recorded delivery outcomes', { outcome: 'dead' })
    metrics.counter('events_received_total', 'Accepted event submissions')
    const text = await metrics.render()
    expect(text).toContain('# TYPE deliveries_total counter')
    expect(text.match(/# TYPE deliveries_total counter/g)).toHaveLength(1)
    expect(text).toContain('deliveries_total{outcome="succeeded"} 1')
    expect(text).toContain('deliveries_total{outcome="dead"} 1')
    expect(text).toContain('events_received_total 1')
  })

  it('increments existing counter series and accepts explicit amounts', async () => {
    const metrics = new Metrics()
    metrics.counter('c', 'c', {}, 3)
    metrics.counter('c', 'c', {}, 2)
    metrics.counter('c', 'c', {})
    expect(await metrics.render()).toContain('c 6')
  })

  it('escapes label values: backslash, double quote, newline', async () => {
    const metrics = new Metrics()
    metrics.counter('escaped', 'e', { path: 'a"b\\c\nd' })
    expect(await metrics.render()).toContain('escaped{path="a\\"b\\\\c\\nd"}')
  })

  it('emits cumulative histogram buckets, sum, count, and +Inf', async () => {
    const metrics = new Metrics()
    metrics.observe('duration_seconds', 'Receiver latency', 0.04)
    metrics.observe('duration_seconds', 'Receiver latency', 2.0)
    metrics.observe('duration_seconds', 'Receiver latency', 30)
    const text = await metrics.render()
    expect(text).toContain('# TYPE duration_seconds histogram')
    expect(text).toContain('duration_seconds_bucket{le="0.025"} 0')
    expect(text).toContain('duration_seconds_bucket{le="0.05"} 1')
    expect(text).toContain('duration_seconds_bucket{le="1"} 1')
    expect(text).toContain('duration_seconds_bucket{le="2.5"} 2')
    expect(text).toContain('duration_seconds_bucket{le="+Inf"} 3')
    expect(text).toContain('duration_seconds_sum{}')
    expect(text).toContain('duration_seconds_count{} 3')
  })

  it('renders histograms with labels plus bucket labels', async () => {
    const metrics = new Metrics()
    metrics.observe('h', 'h', 0.001, { endpoint: 'e1' })
    const text = await metrics.render()
    expect(text).toContain('h_bucket{endpoint="e1",le="0.01"} 1')
    expect(text).toContain('h_bucket{endpoint="e1",le="+Inf"} 1')
    expect(text).toContain('h_count{endpoint="e1"} 1')
  })

  it('caches the database gauges for 5 seconds of injected time', async () => {
    let nowMs = Date.now()
    let fetches = 0
    const metrics = new Metrics({ now: () => nowMs })
    const fakePool = {
      query: async () => {
        fetches += 1
        return { rows: [{ pending: '7', oldest_due: '3.2', circuit_open: '1' }] }
      },
    } as never
    const first = await metrics.render(fakePool)
    nowMs += 2_000
    await metrics.render(fakePool) // within the window: no second fetch
    expect(fetches).toBe(1)
    const third = await metrics.render(fakePool)
    nowMs += 4_000 // crosses the 5 s cache window
    await metrics.render(fakePool)
    expect(fetches).toBe(2)
    expect(first).toContain('deliveries_pending 7')
    expect(first).toContain('oldest_due_delivery_age_seconds 3')
    expect(first).toContain('endpoints_circuit_open 1')
    expect(third).toContain('deliveries_pending 7')
    expect(seriesKey('m', { b: '2', a: '1' })).toBe('m{a="1",b="2"}')
  })

  it('without a pool, no gauges are rendered', async () => {
    const metrics = new Metrics()
    metrics.counter('only_counter', 'c')
    const text = await metrics.render()
    expect(text).toContain('only_counter 1')
    expect(text).not.toContain('deliveries_pending')
  })
})
