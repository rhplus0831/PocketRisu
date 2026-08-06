import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dedupPkg from './assetDedup.cjs'
import storePkg from './assetStore.cjs'
import lockPkg from './assetMaintenanceLock.cjs'

const {
  ASSET_DEDUP_TEMP_PREFIX,
  deduplicateAssetDirectories,
} = dedupPkg as {
  ASSET_DEDUP_TEMP_PREFIX: string
  deduplicateAssetDirectories: (
    assetDirs: string[],
    options?: {
      lockTimeoutMs?: number
      onStage?: (stage: string, detail?: Record<string, any>) => void
      onLocksAcquired?: (locks: MaintenanceLock[]) => void
      releaseLock?: (lock: MaintenanceLock) => void
      fsOps?: typeof fs
    },
  ) => Promise<{ directories: number; scanned: number; linked: number; recovered: number }>
}
interface MaintenanceLock {
  assetDir: string
  lockPath: string
  token: string
  release: () => void
}
const { createAssetStore } = storePkg as {
  createAssetStore: (options: { assetDir: string; maintenanceLock?: boolean }) => {
    assetDir: string
    writeAssetFile: (name: string, bytes: Buffer) => void
    readAssetFile: (name: string) => Buffer | null
    swapAssetDirectoryFromStaging: (
      stagingDir: string,
      backupDir: string,
    ) => { rollback: () => void; finalize: () => void }
  }
}
const { acquireAssetMaintenanceLockSync } = lockPkg as {
  acquireAssetMaintenanceLockSync: (assetDir: string) => MaintenanceLock
}

const roots: string[] = []
const payload = Buffer.from('byte-identical asset payload')

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-dedup-'))
  roots.push(root)
  const left = path.join(root, 'left', 'save', 'assets')
  const right = path.join(root, 'right', 'save', 'assets')
  fs.mkdirSync(left, { recursive: true })
  fs.mkdirSync(right, { recursive: true })
  fs.writeFileSync(path.join(left, 'left.png'), payload)
  fs.writeFileSync(path.join(right, 'right.png'), payload)
  return { root, left, right }
}

function replaceFile(filePath: string, bytes: Buffer) {
  const temp = `${filePath}.replacement`
  fs.writeFileSync(temp, bytes)
  fs.renameSync(temp, filePath)
}

type StatMetadata = Pick<fs.Stats, 'uid' | 'gid' | 'mode'>

function cloneStatWithMetadata(stat: fs.Stats, overrides: Partial<StatMetadata>) {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, overrides) as fs.Stats
}

function makeMetadataFsOps(options: {
  lstatOverrides?: Map<string, Partial<StatMetadata>>
  fstatOverride?: (stat: fs.Stats) => Partial<StatMetadata> | null
  mutations?: { links: number; renames: number; unlinks: number }
} = {}) {
  const fsOps = Object.create(fs) as typeof fs
  fsOps.lstatSync = ((target: fs.PathLike, ...args: any[]) => {
    const stat = (fs.lstatSync as any)(target, ...args) as fs.Stats
    const override = options.lstatOverrides?.get(path.resolve(String(target)))
    return override ? cloneStatWithMetadata(stat, override) : stat
  }) as typeof fs.lstatSync
  fsOps.fstatSync = ((descriptor: number, ...args: any[]) => {
    const stat = (fs.fstatSync as any)(descriptor, ...args) as fs.Stats
    const override = options.fstatOverride?.(stat)
    return override ? cloneStatWithMetadata(stat, override) : stat
  }) as typeof fs.fstatSync
  if (options.mutations) {
    fsOps.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      options.mutations!.links++
      return fs.linkSync(existingPath, newPath)
    }) as typeof fs.linkSync
    fsOps.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      options.mutations!.renames++
      return fs.renameSync(oldPath, newPath)
    }) as typeof fs.renameSync
    fsOps.unlinkSync = ((target: fs.PathLike) => {
      options.mutations!.unlinks++
      return fs.unlinkSync(target)
    }) as typeof fs.unlinkSync
  }
  return fsOps
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('controlled asset deduplication', () => {
  it('ships the worker through the shell entry point and root ignore policy', () => {
    const worker = path.resolve('scripts/dedup-assets.cjs')
    expect(fs.existsSync(worker)).toBe(true)
    expect(spawnSync('git', ['check-ignore', '-q', 'scripts/dedup-assets.cjs']).status).not.toBe(0)

    const invocation = spawnSync('bash', ['scripts/dedup-assets.sh'], { encoding: 'utf8' })
    expect(invocation.status).toBe(2)
    expect(invocation.stderr).toContain('usage: dedup-assets.sh')
    expect(invocation.stderr).not.toContain('MODULE_NOT_FOUND')
  })

  it.each(['', '   ', '\t'])('rejects empty operand %j before any mutation', async (operand) => {
    const { left, right } = makeTree()
    const interrupted = path.join(
      left,
      `${ASSET_DEDUP_TEMP_PREFIX}7-00000000-0000-4000-8000-000000000000`,
    )
    fs.writeFileSync(interrupted, payload)
    const leftBefore = fs.statSync(path.join(left, 'left.png'))
    const rightBefore = fs.statSync(path.join(right, 'right.png'))

    await expect(deduplicateAssetDirectories([left, operand, right]))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_DIRECTORY' })

    expect(fs.existsSync(interrupted)).toBe(true)
    expect(fs.statSync(path.join(left, 'left.png')).ino).toBe(leftBefore.ino)
    expect(fs.statSync(path.join(right, 'right.png')).ino).toBe(rightBefore.ino)
    expect(fs.existsSync(path.join(path.dirname(left), '__asset_maintenance.lock'))).toBe(false)
  })

  it('rejects a whitespace operand through the shipped shell CLI without mutation', () => {
    const { left, right } = makeTree()
    const leftBefore = fs.statSync(path.join(left, 'left.png'))
    const rightBefore = fs.statSync(path.join(right, 'right.png'))

    const invocation = spawnSync(
      'bash',
      ['scripts/dedup-assets.sh', left, '   ', right],
      { encoding: 'utf8' },
    )

    expect(invocation.status).toBe(1)
    expect(invocation.stderr).toContain('operands must be non-empty paths')
    expect(fs.statSync(path.join(left, 'left.png')).ino).toBe(leftBefore.ino)
    expect(fs.statSync(path.join(right, 'right.png')).ino).toBe(rightBefore.ino)
  })

  it('rejects a non-assets directory and a symlinked assets leaf without mutation', async () => {
    const { root, left, right } = makeTree()
    const leafAlias = path.join(root, 'assets-alias')
    fs.symlinkSync(left, leafAlias, 'dir')

    await expect(deduplicateAssetDirectories([root, right]))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_DIRECTORY' })
    await expect(deduplicateAssetDirectories([leafAlias, right]))
      .rejects.toMatchObject({ code: 'ASSET_DIRECTORY_SYMLINK' })
    expect(fs.statSync(path.join(left, 'left.png')).ino)
      .not.toBe(fs.statSync(path.join(right, 'right.png')).ino)
  })

  it('rejects a mixed valid/file/valid API operand list before any mutation', async () => {
    const { root, left, right } = makeTree()
    const fileOperand = path.join(root, 'not-a-directory')
    const interrupted = path.join(
      left,
      `${ASSET_DEDUP_TEMP_PREFIX}7-00000000-0000-4000-8000-000000000000`,
    )
    fs.writeFileSync(fileOperand, 'file operand')
    fs.writeFileSync(interrupted, payload)
    const before = [
      fs.statSync(path.join(left, 'left.png')).ino,
      fs.statSync(path.join(right, 'right.png')).ino,
    ]

    await expect(deduplicateAssetDirectories([left, fileOperand, right]))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_DIRECTORY' })

    expect(fs.existsSync(interrupted)).toBe(true)
    expect(fs.statSync(path.join(left, 'left.png')).ino).toBe(before[0])
    expect(fs.statSync(path.join(right, 'right.png')).ino).toBe(before[1])
  })

  it('rejects a mixed valid/file/valid shell operand list before any mutation', () => {
    const { root, left, right } = makeTree()
    const fileOperand = path.join(root, 'not-a-directory')
    fs.writeFileSync(fileOperand, 'file operand')
    const leftBefore = fs.statSync(path.join(left, 'left.png')).ino
    const rightBefore = fs.statSync(path.join(right, 'right.png')).ino

    const invocation = spawnSync(
      'bash',
      ['scripts/dedup-assets.sh', left, fileOperand, right],
      { encoding: 'utf8' },
    )

    expect(invocation.status).toBe(1)
    expect(invocation.stderr).toContain('operand is not a directory')
    expect(fs.statSync(path.join(left, 'left.png')).ino).toBe(leftBefore)
    expect(fs.statSync(path.join(right, 'right.png')).ino).toBe(rightBefore)
  })

  it('ignores only a missing operand whose lexical basename is assets', async () => {
    const { root, left } = makeTree()
    const missingAssets = path.join(root, 'unmatched-instance', 'save', 'assets')
    const missingOther = path.join(root, 'unmatched-instance', 'save', 'not-assets')
    const belowFile = path.join(root, 'file-parent')
    fs.writeFileSync(belowFile, 'not a directory')

    await expect(deduplicateAssetDirectories([left, missingAssets]))
      .resolves.toMatchObject({ directories: 1, linked: 0 })
    await expect(deduplicateAssetDirectories([left, missingOther]))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_DIRECTORY' })
    await expect(deduplicateAssetDirectories([left, path.join(belowFile, 'assets')]))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_DIRECTORY' })
  })

  it('orders Unicode targets, candidates, and duplicate canonical aliases by UTF-8 bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-dedup-unicode-'))
    roots.push(root)
    const first = path.join(root, 'é-instance', 'save', 'assets')
    const second = path.join(root, '中-instance', 'save', 'assets')
    fs.mkdirSync(first, { recursive: true })
    fs.mkdirSync(second, { recursive: true })
    const firstFile = path.join(first, 'first.png')
    const secondFile = path.join(second, 'second.png')
    fs.writeFileSync(firstFile, payload)
    fs.writeFileSync(secondFile, payload)
    const aliasSave = path.join(root, 'alias-save')
    fs.symlinkSync(path.dirname(first), aliasSave, 'dir')
    const alias = path.join(aliasSave, 'assets')
    let lockOrder: string[] = []
    let publication: { source: { filePath: string }; destination: { filePath: string } } | null = null

    const result = await deduplicateAssetDirectories([second, alias, first], {
      onLocksAcquired(locks) {
        lockOrder = locks.map(lock => lock.assetDir)
      },
      onStage(stage, detail) {
        if (stage === 'before-link') publication = detail as typeof publication
      },
    })

    const byteOrder = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right))
    expect(result.directories).toBe(2)
    expect(lockOrder).toEqual([first, second].sort(byteOrder))
    expect(publication).not.toBeNull()
    expect([publication!.source.filePath, publication!.destination.filePath])
      .toEqual([firstFile, secondFile].sort(byteOrder))
  })

  it('uses one canonical identity through an ancestor symlink for runtime and dedup', async () => {
    const { root, left, right } = makeTree()
    const aliasSave = path.join(root, 'left-save-alias')
    fs.symlinkSync(path.dirname(left), aliasSave, 'dir')
    const aliasAssets = path.join(aliasSave, 'assets')
    const store = createAssetStore({ assetDir: aliasAssets })

    expect(store.assetDir).toBe(left)
    const lock = acquireAssetMaintenanceLockSync(aliasAssets)
    await expect(deduplicateAssetDirectories([left, right], { lockTimeoutMs: 0 }))
      .rejects.toMatchObject({ code: 'ASSET_MAINTENANCE_LOCKED' })
    lock.release()
    await expect(deduplicateAssetDirectories([aliasAssets, right]))
      .resolves.toMatchObject({ linked: 1 })
  })

  it('recovers interrupted names even when only one target remains', async () => {
    const { left } = makeTree()
    const interrupted = path.join(
      left,
      `${ASSET_DEDUP_TEMP_PREFIX}7-00000000-0000-4000-8000-000000000000`,
    )
    fs.writeFileSync(interrupted, payload)

    await expect(deduplicateAssetDirectories([left])).resolves.toMatchObject({
      directories: 1,
      linked: 0,
      recovered: 1,
    })
    expect(fs.existsSync(interrupted)).toBe(false)
  })

  it.each(['uid', 'gid'] as const)(
    'fails closed on mixed target-directory %s before recovery or publication',
    async (field) => {
      const { left, right } = makeTree()
      const interrupted = path.join(
        left,
        `${ASSET_DEDUP_TEMP_PREFIX}7-00000000-0000-4000-8000-000000000000`,
      )
      fs.writeFileSync(interrupted, payload)
      const leftFile = path.join(left, 'left.png')
      const rightFile = path.join(right, 'right.png')
      const before = [fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]
      const rightStat = fs.lstatSync(right)
      const mutations = { links: 0, renames: 0, unlinks: 0 }
      const fsOps = makeMetadataFsOps({
        lstatOverrides: new Map([
          [right, { [field]: rightStat[field] + 1 }],
        ]),
        mutations,
      })

      await expect(deduplicateAssetDirectories([left, right], { fsOps }))
        .rejects.toMatchObject({ code: 'ASSET_DEDUP_METADATA_MISMATCH' })

      expect(mutations).toEqual({ links: 0, renames: 0, unlinks: 0 })
      expect(fs.existsSync(interrupted)).toBe(true)
      expect([fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]).toEqual(before)
    },
  )

  it.each(['uid', 'gid'] as const)(
    'fails closed on mixed candidate-file %s before recovery or publication',
    async (field) => {
      const { left, right } = makeTree()
      const interrupted = path.join(
        left,
        `${ASSET_DEDUP_TEMP_PREFIX}7-00000000-0000-4000-8000-000000000000`,
      )
      const leftFile = path.join(left, 'left.png')
      const rightFile = path.join(right, 'right.png')
      fs.writeFileSync(interrupted, payload)
      const before = [fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]
      const rightStat = fs.lstatSync(rightFile)
      const mutations = { links: 0, renames: 0, unlinks: 0 }
      const fsOps = makeMetadataFsOps({
        lstatOverrides: new Map([
          [rightFile, { [field]: rightStat[field] + 1 }],
        ]),
        mutations,
      })

      await expect(deduplicateAssetDirectories([left, right], { fsOps }))
        .rejects.toMatchObject({ code: 'ASSET_DEDUP_METADATA_MISMATCH' })

      expect(mutations).toEqual({ links: 0, renames: 0, unlinks: 0 })
      expect(fs.existsSync(interrupted)).toBe(true)
      expect([fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]).toEqual(before)
    },
  )

  it('fails closed on mixed target-directory permission modes before recovery or publication', async () => {
    const { left, right } = makeTree()
    const interrupted = path.join(
      left,
      `${ASSET_DEDUP_TEMP_PREFIX}7-00000000-0000-4000-8000-000000000000`,
    )
    const leftFile = path.join(left, 'left.png')
    const rightFile = path.join(right, 'right.png')
    fs.writeFileSync(interrupted, payload)
    fs.chmodSync(left, 0o750)
    fs.chmodSync(right, 0o755)
    const before = [fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]
    const mutations = { links: 0, renames: 0, unlinks: 0 }

    await expect(deduplicateAssetDirectories([left, right], {
      fsOps: makeMetadataFsOps({ mutations }),
    })).rejects.toMatchObject({ code: 'ASSET_DEDUP_METADATA_MISMATCH' })

    expect(mutations).toEqual({ links: 0, renames: 0, unlinks: 0 })
    expect(fs.existsSync(interrupted)).toBe(true)
    expect([fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]).toEqual(before)
  })

  it('preflights the mode of every candidate, including non-duplicates', async () => {
    const { left, right } = makeTree()
    const leftFile = path.join(left, 'left.png')
    const rightFile = path.join(right, 'right.png')
    const unique = path.join(right, 'unique.png')
    fs.chmodSync(leftFile, 0o600)
    fs.chmodSync(rightFile, 0o600)
    fs.writeFileSync(unique, 'not a duplicate', { mode: 0o640 })
    fs.chmodSync(unique, 0o640)
    const before = [fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]
    const mutations = { links: 0, renames: 0, unlinks: 0 }

    await expect(deduplicateAssetDirectories([left, right], {
      fsOps: makeMetadataFsOps({ mutations }),
    })).rejects.toMatchObject({ code: 'ASSET_DEDUP_METADATA_MISMATCH' })

    expect(mutations).toEqual({ links: 0, renames: 0, unlinks: 0 })
    expect([fs.statSync(leftFile).ino, fs.statSync(rightFile).ino]).toEqual(before)
  })

  it('recovers tool temps, excludes every hidden/server temp, and atomically hardlinks bytes', async () => {
    const { left, right } = makeTree()
    fs.writeFileSync(path.join(left, '.tmp-live-publication'), payload)
    fs.writeFileSync(path.join(right, `${ASSET_DEDUP_TEMP_PREFIX}7-00000000-0000-4000-8000-000000000000`), payload)
    fs.writeFileSync(path.join(right, 'unique.png'), Buffer.from('unique'))

    const result = await deduplicateAssetDirectories([left, right])

    expect(result).toMatchObject({ directories: 2, scanned: 3, linked: 1, recovered: 1 })
    const leftStat = fs.statSync(path.join(left, 'left.png'))
    const rightStat = fs.statSync(path.join(right, 'right.png'))
    expect([leftStat.dev, leftStat.ino]).toEqual([rightStat.dev, rightStat.ino])
    expect(fs.readFileSync(path.join(left, '.tmp-live-publication'))).toEqual(payload)
    expect(fs.readFileSync(path.join(right, 'unique.png'))).toEqual(Buffer.from('unique'))
  })

  it('blocks runtime writes and import swaps while dedup owns the lock, then preserves write detachment', async () => {
    const { root, left, right } = makeTree()
    const liveStore = createAssetStore({ assetDir: right })
    const staging = path.join(root, 'right', 'save', 'assets_import_staging')
    const backup = path.join(root, 'right', 'save', 'assets_import_backup')
    fs.mkdirSync(staging)
    fs.writeFileSync(path.join(staging, 'imported.png'), Buffer.from('imported'))
    let checked = false

    await deduplicateAssetDirectories([left, right], {
      onStage(stage) {
        if (stage !== 'after-link' || checked) return
        checked = true
        expect(() => liveStore.writeAssetFile('right.png', Buffer.from('new runtime bytes')))
          .toThrow(/locked by owner pid/)
        expect(() => liveStore.swapAssetDirectoryFromStaging(staging, backup))
          .toThrow(/locked by owner pid/)
      },
    })

    expect(checked).toBe(true)
    liveStore.writeAssetFile('right.png', Buffer.from('new runtime bytes'))
    expect(fs.readFileSync(path.join(left, 'left.png'))).toEqual(payload)
    expect(liveStore.readAssetFile('right.png')).toEqual(Buffer.from('new runtime bytes'))
    expect(fs.statSync(path.join(left, 'left.png')).ino)
      .not.toBe(fs.statSync(path.join(right, 'right.png')).ino)
  })

  it('retains the lock across an import swap lifecycle and releases after rollback', async () => {
    const { root, left, right } = makeTree()
    const liveStore = createAssetStore({ assetDir: right })
    const staging = path.join(root, 'right', 'save', 'assets_import_staging')
    const backup = path.join(root, 'right', 'save', 'assets_import_backup')
    fs.mkdirSync(staging)
    fs.writeFileSync(path.join(staging, 'imported.png'), Buffer.from('imported'))

    const publication = liveStore.swapAssetDirectoryFromStaging(staging, backup)
    await expect(deduplicateAssetDirectories([left, right], { lockTimeoutMs: 0 }))
      .rejects.toMatchObject({ code: 'ASSET_MAINTENANCE_LOCKED' })
    publication.rollback()

    expect(fs.readFileSync(path.join(right, 'right.png'))).toEqual(payload)
    await expect(deduplicateAssetDirectories([left, right], { lockTimeoutMs: 0 }))
      .resolves.toMatchObject({ linked: 1 })
  })

  it('revalidates after the final injection boundary instead of overwriting a raced write', async () => {
    const { left, right } = makeTree()
    const replacement = Buffer.from('new independently published bytes')

    await expect(deduplicateAssetDirectories([left, right], {
      onStage(stage) {
        if (stage === 'after-revalidate') {
          replaceFile(path.join(right, 'right.png'), replacement)
        }
      },
    })).rejects.toThrow(/changed before revalidation|changed immediately before atomic publication/)

    expect(fs.readFileSync(path.join(right, 'right.png'))).toEqual(replacement)
    expect(fs.readdirSync(right).filter((name) => name.startsWith(ASSET_DEDUP_TEMP_PREFIX)))
      .toEqual([])
  })

  it.each(['uid', 'gid', 'mode'] as const)(
    'revalidates candidate %s metadata at the hardlink publication boundary',
    async (field) => {
      const { left, right } = makeTree()
      const leftFile = path.join(left, 'left.png')
      const rightFile = path.join(right, 'right.png')
      const destinationBefore = fs.statSync(rightFile)
      let sourceInode: number | null = null
      let injectMetadataRace = false
      const fsOps = makeMetadataFsOps({
        fstatOverride(stat) {
          if (!injectMetadataRace || stat.ino !== sourceInode) return null
          if (field === 'mode') {
            return { mode: (stat.mode & ~0o7777) | ((stat.mode & 0o7777) ^ 0o040) }
          }
          return { [field]: stat[field] + 1 }
        },
      })

      await expect(deduplicateAssetDirectories([left, right], {
        fsOps,
        onStage(stage, detail) {
          if (stage === 'before-link') {
            sourceInode = fs.statSync(detail!.source.filePath).ino
          }
          if (stage === 'after-revalidate') injectMetadataRace = true
        },
      })).rejects.toThrow(/changed before revalidation|metadata changed/)

      expect(sourceInode).not.toBeNull()
      expect(fs.statSync(rightFile).ino).toBe(destinationBefore.ino)
      expect(fs.readdirSync(right).filter(name => name.startsWith(ASSET_DEDUP_TEMP_PREFIX)))
        .toEqual([])
    },
  )

  it('attempts every target release and preserves a primary failure', async () => {
    const { left, right } = makeTree()
    let locks: MaintenanceLock[] = []
    let failedLock: MaintenanceLock | null = null
    const primary = new Error('primary dedup failure') as Error & { cleanupErrors?: Error[] }

    await expect(deduplicateAssetDirectories([left, right], {
      onLocksAcquired(acquired) {
        locks = acquired
        failedLock = acquired[acquired.length - 1]
      },
      onStage(stage) {
        if (stage === 'after-locks-acquired') throw primary
      },
      releaseLock(lock) {
        if (lock === failedLock) throw new Error('injected release failure')
        lock.release()
      },
    })).rejects.toBe(primary)

    expect(primary.cleanupErrors?.map((error) => error.message))
      .toContain('injected release failure')
    const releasedTarget = locks.find((lock) => lock !== failedLock)!
    const probe = acquireAssetMaintenanceLockSync(releasedTarget.assetDir)
    probe.release()
    failedLock!.release()
  })

  it.each([
    'after-locks-acquired',
    'after-temp-recovery',
    'before-link',
    'after-link',
    'before-revalidate',
    'after-revalidate',
    'after-rename',
    'after-directory-fsync',
  ])('recovers a killed CLI at publication phase %s', async (phase) => {
    const { left, right } = makeTree()
    const cli = path.resolve('scripts/dedup-assets.cjs')
    const crashed = spawnSync(process.execPath, [cli, left, right], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        POCKETRISU_TEST_ASSET_DEDUP_CRASH_AT: phase,
      },
    })
    expect(crashed.signal).toBe('SIGKILL')

    const recovered = spawnSync(process.execPath, [cli, left, right], {
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
    })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(fs.readFileSync(path.join(left, 'left.png'))).toEqual(payload)
    expect(fs.readFileSync(path.join(right, 'right.png'))).toEqual(payload)
    expect(fs.readdirSync(right).filter((name) => name.startsWith(ASSET_DEDUP_TEMP_PREFIX)))
      .toEqual([])
  })
})
