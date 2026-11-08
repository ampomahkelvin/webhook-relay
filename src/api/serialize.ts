import type { CircuitState, DisabledReason, EndpointStatus } from '../db/vocabulary.js'
import type { EndpointRow } from '../db/endpoints.js'
import type { AttemptRow, DeliveryRow } from '../db/deliveries.js'
import type { EventRow } from '../db/events.js'
import type { ApiKeyRow, TenantRow } from '../db/tenants.js'

/**
 * The wire shapes every tenant-facing route maps through. One entity, one
 * mapper: a response field change happens here (and in tests that pin the
 * shape), never per route. The row types are the data modules' own — a
 * column rename starts with a compile error here, not a wire drift.
 */

export function endpointJson(row: EndpointRow): {
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

export function deliveryJson(row: DeliveryRow) {
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

export function eventJson(row: EventRow) {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  }
}

export function attemptJson(row: AttemptRow) {
  return {
    attemptNumber: row.attempt_number,
    startedAt: row.started_at.toISOString(),
    durationMs: row.duration_ms,
    statusCode: row.status_code,
    errorKind: row.error_kind,
    responseSnippet: row.response_snippet,
  }
}

export function tenantJson(row: TenantRow) {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() }
}

export function apiKeyJson(row: ApiKeyRow) {
  return {
    id: row.id,
    prefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }
}
