import { startTestDatabase, type TestDatabase } from './test-db.js'
import { createApp } from '../../src/api/app.js'
import { createLogger } from '../../src/logger.js'

/** Admin key constant for tests; mirrors the config key tests use. */
export const TEST_ADMIN_KEY = 'whkadmin_test_key'
export const TEST_ENCRYPTION_KEY = '/nfxwkRb9px9u/baXe41g2X1qA/v6ADr22Cj1mfkJ1k='

export interface TestAppOptions {
  maxEndpointsPerTenant?: number
  allowInsecureHttp?: boolean
}

export interface TestApp {
  app: ReturnType<typeof createApp>
  db: TestDatabase
  adminKey: string
  stop: () => Promise<void>
}

/** Same as startTestDatabase, plus a running Express app and a silent logger. */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const db = await startTestDatabase()
  const logger = createLogger('test', 'silent')
  const adminKey = TEST_ADMIN_KEY
  const app = createApp({
    pool: db.pool,
    logger,
    adminApiKey: adminKey,
    maxEndpointsPerTenant: options.maxEndpointsPerTenant ?? 20,
    allowInsecureHttp: options.allowInsecureHttp ?? false,
    encryptionKey: TEST_ENCRYPTION_KEY,
  })
  return { app, db, adminKey, stop: () => db.stop() }
}
