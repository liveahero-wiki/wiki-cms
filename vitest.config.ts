import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    test: {
      projects: [
        {
          test: { name: 'unit', include: ['src/**/*.test.ts', 'embed/**/*.test.ts', 'plugin/**/*.test.ts', 'cli/**/*.test.ts', 'admin/**/*.test.ts'], environment: 'node' },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                compatibilityDate: '2026-08-01',
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
                  DISCORD_CLIENT_ID: 'test-client-id',
                  DISCORD_CLIENT_SECRET: 'test-client-secret',
                  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
                  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
                  CLI_TOKEN: 'test-cli-token',
                  PUBLIC_URL: 'http://localhost:8787',
                },
              },
            }),
          ],
          test: { name: 'worker', include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
        },
      ],
    },
  }
})
