// k6/delivery.js — end-to-end delivery lag (DESIGN section 11 / PLAN phase 9).
//
// Each iteration submits one event and then polls the tenant-facing read
// API until its delivery reaches a terminal state, timing the submit ->
// settled span as `custom:lag_ms`. Terminal means `succeeded` or `dead`
// (dead still lands in the lag histogram — a dead letter is an outcome).
//
// Run the dispatcher stack (docker compose) while this executes.
//
// Usage:
//   k6 run -e BASE_URL=http://localhost:8080 \
//          -e API_KEY=whk_... \
//          -e ENDPOINT_ID=<uuid> \
//          [-e EVENT_TYPE=demo.ping] [-e POLL_TIMEOUT_MS=15000] \
//          k6/delivery.js

import http from 'k6/http'
import { sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080'
const API_KEY = __ENV.API_KEY || ''
const ENDPOINT_ID = __ENV.ENDPOINT_ID || ''
const EVENT_TYPE = __ENV.EVENT_TYPE || 'demo.ping'
const POLL_TIMEOUT_MS = Number(__ENV.POLL_TIMEOUT_MS || 15_000)
const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS || 100)

const lag = new Trend('custom:lag_ms', true)
const settled = new Counter('custom:settled')
const dead = new Counter('custom:dead')
const abandoned = new Counter('custom:abandoned')

export const options = {
  scenarios: {
    delivery: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 5), // new deliveries per second
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    'custom:lag_ms': ['p(90)<2000', 'p(95)<5000'],
    'custom:abandoned': ['count<100'],
    http_req_failed: ['rate<0.05'],
  },
}

const tenantHeaders = () => ({
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
})

export default function () {
  if (!API_KEY || !ENDPOINT_ID) {
    throw new Error('API_KEY and ENDPOINT_ID are required')
  }
  const started = Date.now()
  const response = http.post(
    `${BASE_URL}/v1/events`,
    JSON.stringify({ eventType: EVENT_TYPE, payload: { seq: `d:${started}` } }),
    {
      headers: { ...tenantHeaders(), 'Idempotency-Key': `k6dl-${__VU}-${__ITER}-${started}` },
      tags: { name: 'POST /v1/events' },
    },
  )
  if (response.status !== 202) {
    abandoned.add(1)
    return
  }
  const eventId = response.json().id

  // Poll the deliveries of this event until terminal.
  for (let waited = 0; waited < POLL_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
    const list = http.get(`${BASE_URL}/v1/deliveries?eventId=${eventId}&limit=10`, {
      headers: tenantHeaders(),
      tags: { name: 'GET /v1/deliveries' },
    })
    if (list.status === 200) {
      const items = list.json().items || []
      const terminal = items.filter((d) => d.status === 'succeeded' || d.status === 'dead')
      if (items.length > 0 && terminal.length === items.length) {
        const elapsed = Date.now() - started
        lag.add(elapsed)
        settled.add(1)
        if (terminal.some((d) => d.status === 'dead')) dead.add(1)
        return
      }
      if (items.length === 0) {
        // Attempt not yet visible; retry rather than abandon.
      }
    }
    sleep(POLL_INTERVAL_MS / 1000)
  }
  abandoned.add(1)
}
