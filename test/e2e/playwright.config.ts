import { defineConfig } from '@playwright/test'

/**
 * PocketRisu E2E harness. Every test launches its own real server on an
 * isolated temp save dir (see helpers/server.ts), so tests parallelize across
 * workers without writer-lock contention. Requires a current `pnpm build`:
 * the server serves `dist/` and mutation admission checks the build stamp.
 */
export default defineConfig({
  testDir: './scenarios',
  outputDir: '../../test-results/e2e',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
  },
})
