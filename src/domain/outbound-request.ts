import { signWebhook } from './signing.js'
import { validateEndpointUrl } from './endpoint-url.js'
import { canonicalJson } from '../util/canonical-json.js'

/**
 * The outbound webhook request, exactly as DESIGN section 6.2 specifies it:
 * a deterministic JSON body plus the Standard Webhooks signature headers.
 * Pure apart from the clock — `timestampSeconds` comes from the caller so a
 * retry hours later is signed with a fresh timestamp and still verifies.
 */

export interface OutboundEventData {
  /** Receivers dedupe on this — it is `Webhook-Id`, stable across retries. */
  eventId: string
  eventType: string
  createdAtIso: string
  payload: unknown
}

export interface OutboundEndpoint {
  url: string
  secret: string
}

export interface OutboundOptions {
  /** Unix seconds; defaults to now. Injectable for tests. */
  timestampSeconds?: number
  /** Dev escape hatch for `http://` receivers, same policy as registration. */
  allowInsecureHttp?: boolean
}

export interface OutboundRequest {
  target: URL
  headers: Record<string, string>
  body: Buffer
}

/**
 * Layer 2's first check happens here too: the URL is re-validated at send
 * time, including literal-IP ranges. Hostname resolution into blocked
 * ranges is the SSRF client's job (the map, not the giveaway).
 */
export function buildOutboundRequest(
  event: OutboundEventData,
  endpoint: OutboundEndpoint,
  options: OutboundOptions = {},
): OutboundRequest {
  const urlText = validateEndpointUrl(endpoint.url, {
    allowInsecureHttp: options.allowInsecureHttp,
  })
  const target = new URL(urlText)

  const body = Buffer.from(
    canonicalJson({
      id: event.eventId,
      type: event.eventType,
      createdAt: event.createdAtIso,
      data: event.payload,
    }),
    'utf8',
  )

  const timestamp = options.timestampSeconds ?? Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'webhook-service/1.0',
    'content-length': String(body.length),
    'webhook-id': event.eventId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signWebhook(event.eventId, endpoint.secret, timestamp, body),
  }

  return { target, headers, body }
}
