import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from './backupImportIndex.cjs'

const { createBackupImportIndex } = pkg as {
  createBackupImportIndex: (
    filePath: string,
    options?: { batchSize?: number },
  ) => {
    addEntry: (name: string) => boolean
    count: number
    markInlayImported: (id: string) => void
    markInlaySidecar: (id: string, info: unknown) => void
    setLegacyInlayInfo: (id: string, info: unknown) => void
    getInlay: (id: string) => {
      imported: boolean
      sidecar: boolean
      explicit: any
      legacy: any
    } | null
    legacyInlaysMissingSidecars: () => Iterable<{ id: string; info: any }>
    destroy: () => void
  }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('disk-backed backup import index', () => {
  it('deduplicates names across bounded transaction batches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-backup-index-'))
    roots.push(root)
    const filePath = path.join(root, 'index.sqlite')
    const index = createBackupImportIndex(filePath, { batchSize: 3 })

    for (let entry = 0; entry < 100_001; entry++) {
      expect(index.addEntry(`assets/${entry}`)).toBe(true)
    }
    expect(index.addEntry('assets/100000')).toBe(false)
    expect(index.count).toBe(100_001)

    index.destroy()
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('persists order-independent inlay metadata without heap-wide maps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-backup-index-'))
    roots.push(root)
    const index = createBackupImportIndex(path.join(root, 'index.sqlite'), { batchSize: 2 })

    index.setLegacyInlayInfo('legacy', { ext: 'webp', name: 'Legacy' })
    index.markInlayImported('legacy')
    index.markInlaySidecar('explicit', { ext: 'png', name: 'Explicit' })
    index.markInlayImported('explicit')

    expect(index.getInlay('legacy')).toMatchObject({
      imported: true,
      sidecar: false,
      legacy: { ext: 'webp', name: 'Legacy' },
    })
    expect(index.getInlay('explicit')).toMatchObject({
      imported: true,
      sidecar: true,
      explicit: { ext: 'png', name: 'Explicit' },
    })
    expect([...index.legacyInlaysMissingSidecars()]).toEqual([
      { id: 'legacy', info: { ext: 'webp', name: 'Legacy' } },
    ])

    index.destroy()
  })
})
