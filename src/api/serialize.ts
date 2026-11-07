import type {
  CircuitState,
  DeliveryStatus,
  DisabledReason,
  EndpointStatus,
} from '../db/vocabulary.js'

/**
 * The wire shapes every tenant-facing route maps through. One entity, one
 * mapper: a response field change happens here (and in tests that pin the
 * shape), never per route.
 */

export interface EndpointRowShape {
  id: string
  url: string
  description: string | null
  event_types: string[]
  status: EndpointStatus
  disabled_reason: DisabledReason | null
  circuit_state: CircuitState
  created_at: Date
  updated_at: Date
}

export interface DeliveryRowShape {
  id: string
  event_id: string
  endpoint_id: string
  status: DeliveryStatus
  attempt_count: number
  cycle_start: number
  next_attempt_at: Date
  locked_until: Date | null
  completed_at: Date | null
  created_at: Date
}

export function endpointJson(row: EndpointRowShape): {
  id: string
  url: string
  description: string | null
  eventTypes: string[]
  status: EndpointStatus
  disabledReason: DisabledReason | null
  circuitState: CircuitState
  createdAt: string
  updatedAt: string
} {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types,
    status: row.status,
    disabledReason: row.disabled_reason,
    circuitState: row.circuit_state,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function deliveryJson(row: DeliveryRowShape) {
  return {
    id: row.id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    status: row.status,
    attemptCount: row.attempt_count,
    cycleStart: row.cycle_start,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    lockedUntil: row.locked_until?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }
}

export interface EventRowShape {
  id: string
  event_type: string
  payload: unknown
  idempotency_key: string
  created_at: Date
}

export function eventJson(row: EventRowShape) {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  }
}

export interface AttemptRowShape {
  attempt_number: number
  started_at: Date
  duration_ms: number
  status_code: number | null
  error_kind: string | null
  response_snippet: string | null
}

export function attemptJson(row: AttemptRowShape) {
  return {
    attemptNumber: row.attempt_number,
    startedAt: row.started_at.toISOString(),
    durationMs: row.duration_ms,
    statusCode: row.status_code,
    errorKind: row.error_kind,
    responseSnippet: row.response_snippet,
  }
}

export interface TenantRowShape {
  id: string
  name: string
  created_at: Date
}

export function tenantJson(row: TenantRowShape) {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() }
}

export interface ApiKeyRowShape {
  id: string
  key_prefix: string
  created_at: Date
  revoked_at: Date | null
}

export function apiKeyJson(row: ApiKeyRowShape) {
  return {
    id: row.id,
    prefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }
}
