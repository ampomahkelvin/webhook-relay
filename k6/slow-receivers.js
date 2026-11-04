// k6/slow-receivers.js — fairness under two receivers that differ only in
// speed (PLAN phase 9: one fast endpoint, one deliberately slow endpoint,
// hitting the same dispatcher). Both endpoints belong to the same tenant
// but MUST be separate endpoint resources; pass both ids.
//
// Every iteration submits one event to EACH endpoint and times each
// delivery's settle as a tagged trend, so
//
//   k6 run ... k6/slow-receivers.js  (then)  k6 report? / inspect output
//
// shows `custom:lag{endpoint=fast}` vs `custom:lag{endpoint=slow}`; the
// per-endpoint claim cap should keep the slow endpoint from starving the
// fast one (slow lag stays close to its own retry schedule instead of
// pushing fast lag up).
//
// The slow endpoint's receiver can be examples/receiver with
// `?delayMs=1500` appended to its URL.
//
// Usage:
//   k6 run -e BASE_URL=http://localhost:8080 \
//          -e API_KEY=whk_... \
//          -e FAST_ENDPOINT_ID=<uuid> \
//          -e SLOW_ENDPOINT_ID=<uuid> \
//          [-e RATE=2] [-e DURATION=3m] [-e SLOW_POLL_TIMEOUT_MS=40000] \
//          k6/slow-receivers.js

import http from 'k6/http'
import { sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080'
const API_KEY = __ENV.API_KEY || ''
const FAST_ENDPOINT_ID = __ENV.FAST_ENDPOINT_ID || ''
const SLOW_ENDPOINT_ID = __ENV.SLOW_ENDPOINT_ID || ''
const EVENT_TYPE = __ENV.EVENT_TYPE || 'demo.ping'
const FAST_TIMEOUT = Number(__ENV.FAST_POLL_TIMEOUT_MS || 10_000)
const SLOW_TIMEOUT = Number(__ENV.SLOW_POLL_TIMEOUT_MS || 40_000)
const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS || 150)

const lagFast = new Trend('custom:lag_fast', true)
const lagSlow = new Trend('custom:lag_slow', true)
const abandonedFast = new Counter('custom:abandoned_fast')
const abandonedSlow = new Counter('custom:abandoned_slow')
const deadSlow = new Counter('custom:dead_slow')

export const options = {
  scenarios: {
    pair: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 2), // pairs per second
      timeUnit: '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: 20,
      maxVUs: 200, // poll loops for many concurrent slow deliveries
    },
  },
  thresholds: {
    // Fairness shape: slow is slower, but fast stays fast.
    'custom:lag_fast': ['p(95)<10000'],
    'custom:lag_slow': ['avg<45000'],
    http_req_failed: ['rate<0.05'],
  },
}

const tenantHeaders = () => ({
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
})

/** Submit to one endpoint and poll it to a terminal state. */
function oneLeg(endpointId, started, timeoutMs, tag) {
  const response = http.post(
    `${BASE_URL}/v1/events`,
    JSON.stringify({ eventType: EVENT_TYPE, payload: { leg: tag, seq: `${started}` } }),
    {
      headers: {
        ...tenantHeaders(),
        'Idempotency-Key': `k6sl-${tag}-${__VU}-${__ITER}-${started}`,
      },
      tags: { name: 'POST /v1/events' },
    },
  )
  if (response.status !== 202) {
    abandonedFast.add(tag === 'fast' ? 1 : 0)
    abandonedSlow.add(tag === 'slow' ? 1 : 0)
    return
  }
  const eventId = response.json().id
  for (let waited = 0; waited < timeoutMs; waited += POLL_INTERVAL_MS) {
    const list = http.get(`${BASE_URL}/v1/deliveries?endpointId=${endpointId}&eventId=${eventId}`, {
      headers: tenantHeaders(),
      tags: { name: 'GET /v1/deliveries' },
    })
    if (list.status === 200) {
      const items = list.json().items || []
      const terminal = items.filter((d) => d.status === 'succeeded' || d.status === 'dead')
      if (items.length > 0 && terminal.length === items.length) {
        const elapsed = Date.now() - started
        ;(tag === 'fast' ? lagFast : lagSlow).add(elapsed)
        if (tag === 'slow' && terminal.some((d) => d.status === 'dead')) deadSlow.add(1)
        return
      }
    }
    sleep(POLL_INTERVAL_MS / 1000)
  }
  abandonedFast.add(tag === 'fast' ? 1 : 0)
  abandonedSlow.add(tag === 'slow' ? 1 : 0)
}

export default function () {
  if (!API_KEY || !FAST_ENDPOINT_ID || !SLOW_ENDPOINT_ID) {
    throw new Error('API_KEY, FAST_ENDPOINT_ID, SLOW_ENDPOINT_ID are required')
  }
  const started = Date.now()
  oneLeg(FAST_ENDPOINT_ID, started, FAST_TIMEOUT, 'fast')
  oneLeg(SLOW_ENDPOINT_ID, started, SLOW_TIMEOUT, 'slow')
}
