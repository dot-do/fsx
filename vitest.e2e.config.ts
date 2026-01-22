/**
 * Vitest configuration for E2E tests using Miniflare
 *
 * This configuration runs E2E tests that use Miniflare directly to test
 * real Durable Object behavior, persistence, and R2 operations without
 * the @cloudflare/vitest-pool-workers abstraction.
 *
 * Run with: npx vitest run --config vitest.e2e.config.ts
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // Use default pool (Node.js) since we control Miniflare directly
    pool: 'forks',
    // Longer timeout for E2E tests that involve DO persistence
    testTimeout: 30000,
    // Run tests sequentially to avoid Miniflare instance conflicts
    sequence: {
      concurrent: false,
    },
    // Ensure proper cleanup between tests
    isolate: true,
    // Environment setup
    env: {
      NODE_ENV: 'test',
    },
  },
  // Resolve TypeScript paths
  resolve: {
    alias: {
      '@': '/Users/nathanclevenger/projects/fsx',
    },
  },
})
