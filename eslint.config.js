import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'examples/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Test files (N3): the split suites' shared helper called `expect`
    // without importing it — invisible to tsc AND to this linter, because
    // typescript-eslint disables no-undef for TS. Re-enabling it for tests
    // (with the Node globals tests use) makes "used but never imported"
    // a lint error, so the next missing vitest import fails `npm run lint`
    // instead of dying at runtime in beforeAll.
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: { 'no-undef': 'error' },
  },
)
