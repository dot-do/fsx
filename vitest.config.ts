import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'tests/**/*.test.ts', 'core/**/*.test.ts', 'storage/**/*.test.ts', 'cli/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
})
