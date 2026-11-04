// k6/intake.js — pure intake load (DESIGN section 11 / PLAN phase 9).
//
// Ramps VUs against POST /v1/events with a unique Idempotency-Key per
// request, so every request does real insert work (no idempotent replay
// short circuit). Latency, throughput, and 429 distributions land in
// k6's standard http metrics plus the custom counters below.
//
// Usage (k6 >= 0.43):
//   k6 run -e BASE_URL=http://localhost:8080 \
//          -e API_KEY=whk_... \
//          [-e EVENT_TYPE=demo.ping] [-e PAYLOAD_BYTES=512] \
//          k6/intake.js

import http from 'k6/http'
import { sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080'
const API_KEY = __ENV.API_KEY || ''
const EVENT_TYPE = __ENV.EVENT_TYPE || 'demo.ping'
const PAYLOAD_BYTES = Number(__ENV.PAYLOAD_BYTES || 512)
// Small inter-iteration padding so a single VU does not exceed a
// sensible per-connection rate; the ramp provides the scale.
const ITERATION_PAUSE = Number(__ENV.ITERATION_PAUSE || 0.05)

const sent = new Counter('custom:sent')
const rejected4xx = new Counter('custom:rejected_4xx')
const intakeLatency = new Trend('custom:intake_latency_ms', true)

// Burst -> cruise: warm, soak, hold, ramp down.
export const options = {
  scenarios: {
    intake: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '1m', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '10s', target: 0 },
      ],
      gracefulStop: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'], // 429 by design still counts as a failure
    'http_req_duration{scenario:intake}': ['p(95)<500'],
  },
}

const filler = 'x'.repeat(Math.max(0, PAYLOAD_BYTES - 32))

export default function () {
  if (!API_KEY) throw new Error('API_KEY is required (tenant bearer key)')
  const key = `k6-${__VU}-${__ITER}-${Date.now()}`
  const response = http.post(
    `${BASE_URL}/v1/events`,
    JSON.stringify({ eventType: EVENT_TYPE, payload: { filler, seq: `${__VU}:${__ITER}` } }),
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Idempotency-Key': key,
        'Content-Type': 'application/json',
      },
      tags: { name: 'POST /v1/events' },
    },
  )
  if (response.status === 202) sent.add(1)
  else if (response.status >= 400 && response.status < 500) rejected4xx.add(1)
  intakeLatency.add(response.timings.duration)
  sleep(ITERATION_PAUSE)
}
