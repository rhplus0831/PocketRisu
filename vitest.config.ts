import { svelte } from "@sveltejs/vite-plugin-svelte"
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const browserBufferPath = fileURLToPath(
  new URL('./node_modules/buffer/index.js', import.meta.url),
)

export default defineConfig({
  plugins: [
    svelte(),
  ],
  resolve: {
    alias: [
      { find: 'src', replacement: '/src' },
      // Vitest executes through Vite's SSR pipeline, where bare "buffer"
      // otherwise resolves to Node's built-in implementation. Client tests
      // must exercise the npm polyfill that the browser bundle actually uses.
      { find: /^buffer$/, replacement: browserBufferPath },
    ],
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['vitest.setup.ts'],
    // compat suite has its own node-environment config (vitest.config.compat.ts);
    // exclude here so `pnpm test` doesn't pick them up under the wrong environment.
    exclude: ['node_modules/**', 'test/compat/**'],
  },
})
