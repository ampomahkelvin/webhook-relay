import { describe, expect, it } from 'vitest'
import { buildOutboundRequest } from '../../src/domain/outbound-request.js'
import { signWebhook } from '../../src/domain/signing.js'
import { InvalidEndpointUrlError } from '../../src/domain/endpoint-url.js'

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const EVENT = {
  eventId: 'a7f77c9e-7e9c-4c4a-9a4d-4a5cf7db5f2b',
  eventType: 'invoice.paid',
  createdAtIso: '2026-10-30T12:00:00.000Z',
  payload: { amount: 42, currency: 'USD' },
}

describe('buildOutboundRequest', () => {
  const built = buildOutboundRequest(EVENT, { url: 'https://r.example.com/hook', secret: SECRET })

  it('builds the DESIGN section 6.2 body', () => {
    const body = JSON.parse(built.body.toString('utf8')) as Record<string, unknown>
    expect(body).toEqual({
      id: EVENT.eventId,
      type: 'invoice.paid',
      createdAt: EVENT.createdAtIso,
      data: { amount: 42, currency: 'USD' },
    })
  })

  it('carries the Standard Webhooks headers', () => {
    expect(built.headers['content-type']).toBe('application/json')
    expect(built.headers['user-agent']).toBe('webhook-service/1.0')
    expect(built.headers['webhook-id']).toBe(EVENT.eventId)
    expect(built.headers['webhook-timestamp']).toMatch(/^\d+$/)
    expect(built.headers['webhook-signature']).toMatch(/^v1,/)
  })

  it('signs the exact bytes that are sent', () => {
    const timestamp = 1_700_000_000
    const pinned = buildOutboundRequest(
      EVENT,
      { url: 'https://r.example.com', secret: SECRET },
      {
        timestampSeconds: timestamp,
      },
    )
    expect(pinned.headers['webhook-timestamp']).toBe('1700000000')
    expect(pinned.headers['webhook-signature']).toBe(
      signWebhook(EVENT.eventId, SECRET, timestamp, pinned.body),
    )
    expect(pinned.headers['content-length']).toBe(String(pinned.body.length))
  })

  it('is deterministic for equal events', () => {
    const again = buildOutboundRequest(
      EVENT,
      { url: 'https://r.example.com/hook', secret: SECRET },
      {
        timestampSeconds: Number(built.headers['webhook-timestamp']),
      },
    )
    expect(again.body.equals(built.body)).toBe(true)
    expect(again.headers['webhook-signature']).toBe(built.headers['webhook-signature'])
  })

  it('re-applies layer 2 at send time', () => {
    // Blocked literal IP: rejected even though the scheme is fine.
    expect(() =>
      buildOutboundRequest(EVENT, { url: 'https://127.0.0.1/hook', secret: SECRET }),
    ).toThrow(InvalidEndpointUrlError)
    // Decimal-encoded loopback normalizes under the WHATWG parser, then blocks.
    expect(() =>
      buildOutboundRequest(EVENT, { url: 'https://2130706433/hook', secret: SECRET }),
    ).toThrow(InvalidEndpointUrlError)
    // Embedded credentials are rejected.
    expect(() =>
      buildOutboundRequest(EVENT, { url: 'https://user:pw@r.example.com/hook', secret: SECRET }),
    ).toThrow(InvalidEndpointUrlError)
    // Plain http only when explicitly allowed (dev flag).
    expect(() =>
      buildOutboundRequest(EVENT, { url: 'http://r.example.com/hook', secret: SECRET }),
    ).toThrow(InvalidEndpointUrlError)
    expect(
      buildOutboundRequest(
        EVENT,
        { url: 'http://r.example.com/hook', secret: SECRET },
        { allowInsecureHttp: true },
      ).target.protocol,
    ).toBe('http:')
  })
})
