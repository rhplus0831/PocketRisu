import { readFileSync, statfsSync } from 'node:fs'
import { totalmem } from 'node:os'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

function positiveInteger(name, fallback) {
  const parsed = Number(process.env[name])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function effectiveMemoryLimit() {
  let limit = totalmem()
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    if (raw !== 'max') {
      const cgroupLimit = Number(raw)
      if (Number.isSafeInteger(cgroupLimit) && cgroupLimit > 0) {
        limit = Math.min(limit, cgroupLimit)
      }
    }
  } catch {
    // Non-Linux hosts and cgroup v1 can rely on os.totalmem().
  }
  return limit
}

const rowMiB = positiveInteger('POCKETRISU_EXTREME_ROW_MIB', 28)
const rows = positiveInteger('POCKETRISU_EXTREME_ROWS', 16)
const heapMiB = positiveInteger('POCKETRISU_EXTREME_HEAP_MIB', 6 * 1024)

if (rowMiB > 32) {
  throw new Error(
    `POCKETRISU_EXTREME_ROW_MIB=${rowMiB} exceeds the production transition limit of 32 MiB per row. Increase POCKETRISU_EXTREME_ROWS instead.`,
  )
}

const totalLogicalBytes = rowMiB * rows * MIB
const defaultProfile = rowMiB === 28 && rows === 16
const requiredMemoryBytes = Math.max(defaultProfile ? 6 * GIB : GIB, totalLogicalBytes * 4)
const requiredDiskBytes = Math.max(defaultProfile ? 8 * GIB : GIB, totalLogicalBytes * 6)
const memoryLimit = effectiveMemoryLimit()
const disk = statfsSync(process.cwd())
const freeDiskBytes = disk.bavail * disk.bsize
const skipResourceCheck = process.env.POCKETRISU_EXTREME_SKIP_RESOURCE_CHECK === '1'

console.info('[PM2 extreme] configuration', JSON.stringify({
  rowMiB,
  rows,
  totalLogicalMiB: totalLogicalBytes / MIB,
  targetRssMiB: positiveInteger('POCKETRISU_EXTREME_TARGET_RSS_MIB', 2 * 1024),
  heapMiB,
  effectiveMemoryMiB: Math.floor(memoryLimit / MIB),
  freeDiskMiB: Math.floor(freeDiskBytes / MIB),
}))

if (!skipResourceCheck && memoryLimit < requiredMemoryBytes) {
  throw new Error(
    `Extreme performance test requires at least ${Math.ceil(requiredMemoryBytes / GIB)} GiB `
    + `of addressable memory; detected ${Math.floor(memoryLimit / GIB)} GiB. `
    + 'Use smaller POCKETRISU_EXTREME_ROW_MIB/POCKETRISU_EXTREME_ROWS values for a smoke run.',
  )
}
if (!skipResourceCheck && freeDiskBytes < requiredDiskBytes) {
  throw new Error(
    `Extreme performance test requires at least ${Math.ceil(requiredDiskBytes / GIB)} GiB `
    + `of free workspace disk; detected ${Math.floor(freeDiskBytes / GIB)} GiB. `
    + 'The transition temporarily retains inline, staged, and optimized publications.',
  )
}

const vitest = './node_modules/vitest/vitest.mjs'
const { spawnSync } = await import('node:child_process')
const result = spawnSync(
  process.execPath,
  [
    `--max-old-space-size=${heapMiB}`,
    '--expose-gc',
    vitest,
    'run',
    '--disableConsoleIntercept',
    '--config',
    'vitest.config.performance-extreme.ts',
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      POCKETRISU_PERF_EXTREME: '1',
      POCKETRISU_PERF_RESOURCE_CACHE: 'off',
    },
    stdio: 'inherit',
  },
)

if (result.error) throw result.error
if (result.signal) {
  throw new Error(`Extreme performance test terminated by ${result.signal}`)
}
if (result.status !== 0) process.exit(result.status ?? 1)
