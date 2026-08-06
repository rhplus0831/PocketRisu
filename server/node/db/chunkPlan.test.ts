import { afterEach, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import planPkg from './chunkPlan.cjs'
import chunkPkg from './chunkStore.cjs'

const {
  prepareFileChunkPlan,
  chunkPlanMetrics,
  resetChunkPlanMetricsForTests,
} = planPkg as {
  prepareFileChunkPlan: (
    filePath: string,
    options?: { forceFailure?: boolean },
  ) => Promise<any>
  chunkPlanMetrics: () => Record<string, number>
  resetChunkPlanMetricsForTests: () => void
}
const { createChunkStore } = chunkPkg as {
  createChunkStore: (db: any, options: { threshold: number }) => any
}

const roots: string[] = []

function seededBytes(size: number): Buffer {
  const value = Buffer.allocUnsafe(size)
  let state = 17
  for (let index = 0; index < size; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    value[index] = state >>> 24
  }
  return value
}

function database() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
  return db
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  resetChunkPlanMetricsForTests()
})

describe('off-loop chunk planning', () => {
  test('computes CDC, chunk digests, and the logical digest in one bounded worker pass', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chunk-plan-'))
    roots.push(root)
    const bytes = seededBytes(3 * 1024 * 1024 + 31)
    const source = path.join(root, 'value.bin')
    fs.writeFileSync(source, bytes)

    const plan = await prepareFileChunkPlan(source)
    expect(plan.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(plan.md5).toBe(createHash('md5').update(bytes).digest('hex'))
    expect(plan.maxWindowBytes).toBeLessThanOrEqual(64 * 1024)
    expect(plan.cdcPasses).toBe(1)
    expect(plan.logicalDigestPasses).toBe(1)
    expect(plan.chunks.reduce((sum: number, chunk: any) => sum + chunk.length, 0))
      .toBe(bytes.length)

    const db = database()
    const store = createChunkStore(db, { threshold: 1024 })
    const result = store.putValueFromFile('large', source, { chunkPlan: plan })
    expect(result.sha256).toBe(plan.sha256)
    expect(store.getValue('large')).toEqual(bytes)
    expect(store.writeMetrics()).toMatchObject({
      preparedFilePublications: 1,
      synchronousFileFallbacks: 0,
      secondFullValueDigestPasses: 0,
    })
    expect(chunkPlanMetrics()).toMatchObject({
      completed: 1,
      failed: 0,
      maxActive: 1,
      cdcPasses: 1,
      logicalDigestPasses: 1,
    })
    db.close()
  })

  test('worker failure leaves the existing synchronous file path byte-identical', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chunk-fallback-'))
    roots.push(root)
    const bytes = seededBytes(2 * 1024 * 1024 + 7)
    const source = path.join(root, 'value.bin')
    fs.writeFileSync(source, bytes)
    await expect(prepareFileChunkPlan(source, { forceFailure: true }))
      .rejects.toThrow('Injected chunk-plan worker failure')

    const db = database()
    const store = createChunkStore(db, { threshold: 1024 })
    const result = store.putValueFromFile('large', source)
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(store.getValue('large')).toEqual(bytes)
    expect(store.writeMetrics()).toMatchObject({
      preparedFilePublications: 0,
      synchronousFileFallbacks: 1,
      cdcPasses: 1,
      logicalDigestPasses: 1,
      secondFullValueDigestPasses: 0,
    })
    expect(chunkPlanMetrics()).toMatchObject({ failed: 1, completed: 0 })
    db.close()
  })
})
