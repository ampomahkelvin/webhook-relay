import { describe, expect, it, vi } from 'vitest'
import { createConcurrencyGate } from '../../src/dispatcher/concurrency-gate.js'

const never: Promise<void> = new Promise(() => {})
const resolved: Promise<void> = Promise.resolve()

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('createConcurrencyGate', () => {
  it('reports capacity while below the limit and blocks it at the limit', () => {
    const gate = createConcurrencyGate(2, never)
    expect(gate.hasCapacity()).toBe(true)
    void gate.track(resolved)
    void gate.track(deferred().promise)
    expect(gate.hasCapacity()).toBe(false)
    expect(gate.inFlightCount()).toBe(2)
  })

  it('waitCapacity resolves when a tracked worker settles', async () => {
    const gate = createConcurrencyGate(1, never)
    const worker = deferred()
    void gate.track(worker.promise)

    let woken = false
    const waiting = gate.waitCapacity().then(() => {
      woken = true
    })
    await vi.waitFor(() => expect(woken).toBe(false)) // still blocked
    worker.resolve()
    await waiting
    // The settled worker frees its slot.
    await vi.waitFor(() => expect(gate.inFlightCount()).toBe(0))
    expect(gate.hasCapacity()).toBe(true)
  })

  it('waitCapacity resolves when the stop signal fires', async () => {
    let resolveStop = () => {}
    const stopSignal = new Promise<void>((r) => {
      resolveStop = r
    })
    const gate = createConcurrencyGate(1, stopSignal)
    void gate.track(deferred().promise)

    let woken = false
    void gate.waitCapacity().then(() => {
      woken = true
    })
    await vi.waitFor(() => expect(woken).toBe(false))
    resolveStop()
    await vi.waitFor(() => expect(woken).toBe(true))
  })

  it('drain resolves only after every in-flight worker settles', async () => {
    const gate = createConcurrencyGate(3, never)
    const a = deferred()
    const b = deferred()
    void gate.track(a.promise)
    void gate.track(b.promise)

    let drained = false
    const draining = gate.drain().then(() => {
      drained = true
    })
    await vi.waitFor(() => expect(drained).toBe(false))
    a.resolve()
    await vi.waitFor(() => expect(gate.inFlightCount()).toBe(1))
    expect(drained).toBe(false)
    b.resolve()
    await draining
    expect(gate.inFlightCount()).toBe(0)
  })

  it('a new waitCapacity waiter is woken per freed slot', async () => {
    const gate = createConcurrencyGate(1, never)
    const worker = deferred()
    void gate.track(worker.promise)

    const first = gate.waitCapacity()
    const second = gate.waitCapacity()
    worker.resolve()
    await Promise.all([first, second])
    expect(gate.hasCapacity()).toBe(true)
  })
})
