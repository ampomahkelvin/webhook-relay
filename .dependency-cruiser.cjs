/**
 * Dependency rules (`npm run lint:deps`). They encode the layering the
 * restructure established:
 *
 *   main  →  api | dispatcher | maintenance  →  db  →  domain  →  util
 *
 *  - `domain` is the innermost layer: it imports nothing but `util` and
 *    node built-ins, so every business rule stays runnable without I/O.
 *  - `db` owns all SQL and may only see `domain` (vocabulary/breaker),
 *    `util`, and the logger — never a process or transport module.
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
  ],
  options: {
    doNotFollow: 'node_modules',
  },
}
