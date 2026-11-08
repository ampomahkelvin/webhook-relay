/**
 * The database schema's closed sets (migrations/0001_initial.sql) as ONE
 * TypeScript owner. Every TS union for a column with a SQL enum or CHECK
 * is declared here and imported elsewhere; renaming a value changes this
 * file and the migration in the same breath, visibly.
 */

/** delivery_status — SQL enum in migrations/0001_initial.sql. */
export const DELIVERY_STATUSES = ['pending', 'succeeded', 'dead'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

/** endpoint_status — SQL enum. */
export const ENDPOINT_STATUSES = ['enabled', 'disabled'] as const
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number]

/** circuit_state — SQL enum; transitions are owned by src/domain/breaker.ts. */
export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const
export type CircuitState = (typeof CIRCUIT_STATES)[number]

/** endpoints.disabled_reason — SQL CHECK. 'gone' is set by the dispatcher's 410 handling, 'failing' by maintenance auto-disable, 'manual' by the API. */
export const DISABLED_REASONS = ['manual', 'gone', 'failing'] as const
export type DisabledReason = (typeof DISABLED_REASONS)[number]

/** delivery_attempts.error_kind — SQL CHECK; values are the transport failures the SSR client can report plus the classifier's http_status. */
export const ERROR_KINDS = [
  'timeout',
  'connection',
  'dns',
  'tls',
  'blocked_address',
  'redirect',
  'http_status',
] as const
export type ErrorKind = (typeof ERROR_KINDS)[number]

/**
 * The event-type name grammar, shared by intake validation, endpoint
 * registration, and mirrored by a CHECK in the migration. The three
 * callers must agree for fan-out matching to work: an endpoint is only
 * matched by events whose type can exist.
 */
export const EVENT_TYPE_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/
/** Wildcard subscription: matches every event type and must be used alone (checked at endpoint registration). */
export const WILDCARD_EVENT_TYPE = '*'
export const MAX_EVENT_TYPE_LENGTH = 100

/** Payload budget: enforced at intake; the body parser limit must exceed it by envelope headroom. */
export const MAX_PAYLOAD_BYTES = 256 * 1024
export const BODY_LIMIT_BYTES = 300 * 1024
