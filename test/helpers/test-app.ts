import { startTestDatabase, type TestDatabase } from './test-db.js'
import { createApp } from '../../src/api/app.js'
import { createLogger } from '../../src/logger.js'

/** Admin key constant for tests; mirrors the module under test. */
export const TEST_ADMIN_KEY = 'whkadmin_test_key'

export interface TestApp {
  app: ReturnType<typeof createApp>
  db: TestDatabase
  adminKey: string
  stop: () => Promise<void>
}

/** Same as startTestDatabase, plus a running Express app and a silent logger. */
export async function startTestApp(): Promise<TestApp> {
  const db = await startTestDatabase()
  const logger = createLogger('test', 'silent')
  const adminKey = TEST_ADMIN_KEY
  const app = createApp({ pool: db.pool, logger, adminApiKey: adminKey })
  return { app, db, adminKey, stop: () => db.stop() }
}
