import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { src: '/src' },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    include: ['test/performance/**/*.test.ts'],
    setupFiles: ['vitest.setup.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    execArgv: ['--expose-gc'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
})
