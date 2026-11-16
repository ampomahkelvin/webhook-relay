/**
 * Dependency rules (`npm run lint:deps`). They encode the layering the
 * restructure established:
 *
 *   main  →  api | dispatcher | maintenance  →  db  →  domain  →  util
 *                          observability ↗
 *
 *  - `domain` is the innermost layer: it imports nothing but `util` and
 *    node built-ins, so every business rule stays runnable without I/O.
 *  - `db` owns all SQL and may only see `domain` (vocabulary/breaker),
 *    `util`, and the logger — never a process or transport module.
 *  - `api`, `dispatcher`, and `maintenance` are sibling processes: they
 *    may not import each other — only `main/` wires entrypoints together.
 *  - `observability` serves the processes (metrics, control routes) but
 *    knows nothing about them; it may read `db` and `infra`, never a
 *    process module.
 *  - no circular dependencies anywhere.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A dependency cycle means two modules decide each other’s rules.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-innermost',
      severity: 'error',
      comment: 'domain must not import other src layers (only util, logger, and node built-ins).',
      from: { path: '^src/domain' },
      to: { path: '^src/(?!domain|util|logger)' },
    },
    {
      name: 'db-sees-only-domain',
      severity: 'error',
      comment: 'db owns the SQL; it must not import api/dispatcher/maintenance/infra/config.',
      from: { path: '^src/db' },
      to: { path: '^src/(?!db|domain|util|logger)' },
    },
    {
      name: 'infra-has-no-process-knowledge',
      severity: 'error',
      comment: 'infra (ssrf-client, secret-box) is reusable transport/crypto: no processes, no db.',
      from: { path: '^src/infra' },
      to: { path: '^src/(?!infra|domain|util|logger)' },
    },
    {
      name: 'api-stands-alone',
      severity: 'error',
      comment: 'The api process must not import its sibling processes (dispatcher, maintenance).',
      from: { path: '^src/api' },
      to: { path: '^src/(?!api)(dispatcher|maintenance)' },
    },
    {
      name: 'dispatcher-stands-alone',
      severity: 'error',
      comment: 'The dispatcher process must not import its sibling processes (api, maintenance).',
      from: { path: '^src/dispatcher' },
      to: { path: '^src/(?!dispatcher)(api|maintenance)' },
    },
    {
      name: 'maintenance-stands-alone',
      severity: 'error',
      comment: 'The maintenance process must not import its sibling processes (api, dispatcher).',
      from: { path: '^src/maintenance' },
      to: { path: '^src/(?!maintenance)(api|dispatcher)' },
    },
    {
      name: 'observability-knows-no-process',
      severity: 'error',
      comment:
        'observability serves the processes (metrics, control routes) but knows nothing about them.',
      from: { path: '^src/observability' },
      to: { path: '^src/(api|dispatcher|maintenance|main)' },
    },
  ],
  options: {
    doNotFollow: 'node_modules',
  },
}
