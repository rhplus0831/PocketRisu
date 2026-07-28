import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

const requestedHeapMiB = Number(process.env.POCKETRISU_EXTREME_HEAP_MIB)
const heapMiB = Number.isSafeInteger(requestedHeapMiB) && requestedHeapMiB > 0
  ? requestedHeapMiB
  : 6 * 1024

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { src: '/src' },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    // Deliberately exclude the ordinary performance suite. This config is only
    // reachable through the explicit extreme package script.
    include: ['test/performance/plugin-storage-transition-memory.test.ts'],
    setupFiles: ['vitest.setup.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    execArgv: ['--expose-gc', `--max-old-space-size=${heapMiB}`],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
  },
})
