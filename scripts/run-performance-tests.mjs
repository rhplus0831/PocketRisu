import { spawnSync } from 'node:child_process'

const vitest = './node_modules/vitest/vitest.mjs'
for (const cacheMode of ['off', 'on']) {
  console.info(`\n[PM2] Running isolated ${cacheMode} resource-cache memory cycle`)
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', vitest, 'run', '--config', 'vitest.config.performance.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        POCKETRISU_PERF_RESOURCE_CACHE: cacheMode,
      },
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
