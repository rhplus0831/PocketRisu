import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/compat/**/*.test.ts'],
    // Hang guards only — these tests spawn real servers, and a full parallel
    // run on a small CI runner can push a legitimately-passing file past 30 s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
