import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let db: TestDatabase
beforeAll(async () => {
  db = await startTestDatabase()
})
afterAll(() => db.stop())

const EXPECTED_TABLES = [
  'tenants',
  'api_keys',
  'endpoints',
  'events',
  'deliveries',
  'delivery_attempts',
  'schema_migrations',
]

describe('initial schema', () => {
  it('creates all seven application tables', async () => {
    const result = await db.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    )

    const names = result.rows.map((row) => row.tablename).sort()
    for (const table of EXPECTED_TABLES) {
      expect(names).toContain(table)
    }
  })

  it('records applied migrations', async () => {
    const result = await db.pool.query<{ name: string }>('SELECT name FROM schema_migrations')

    expect(result.rows.map((row) => row.name)).toEqual(['0001_initial.sql'])
  })

  it('inserts a tenant', async () => {
    const result = await db.pool.query<{ id: string; created_at: Date }>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id, created_at',
      ['acme'],
    )

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.id).toBeDefined()
    expect(result.rows[0]?.created_at).toBeInstanceOf(Date)
  })

  it('enforces the (tenant_id, idempotency_key) uniqueness on events', async () => {
    const tenant = await db.pool
      .query<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', ['dupco'])
      .then((result) => result.rows[0]?.id as string)

    const insert = () =>
      db.pool.query(
        `INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant, 'invoice.paid', JSON.stringify({ amount: 10 }), 'key-1', Buffer.alloc(32, 1)],
      )

    await expect(insert()).resolves.toBeDefined()
    await expect(insert()).rejects.toMatchObject({ code: '23505' })
  })

  it('rejects payloads that are not JSON objects', async () => {
    const tenant = await db.pool
      .query<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', ['payloadco'])
      .then((result) => result.rows[0]?.id as string)

    await expect(
      db.pool.query(
        `INSERT INTO events (tenant_id, event_type, payload, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant, 'invoice.paid', '[]', 'key-array', Buffer.alloc(32, 2)],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
