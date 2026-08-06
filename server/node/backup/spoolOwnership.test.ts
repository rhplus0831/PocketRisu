import { afterEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import spoolOwnershipPkg from './spoolOwnership.cjs'

const {
  SPOOL_OWNER_ID_FILENAME,
  UUID_PATTERN,
  readOrCreatePersistentUuid,
  resolveOwnedSpoolDir,
  resolveOwnedSpoolDirFromSave,
  claimOwnedSpoolNamespaceSync,
  ensureOwnedSpoolDirSync,
  openPinnedOwnedSpoolDirSync,
  withQuarantinedOwnedSpoolDirSync,
} = spoolOwnershipPkg as {
  SPOOL_OWNER_ID_FILENAME: string
  UUID_PATTERN: RegExp
  readOrCreatePersistentUuid: (
    filePath: string,
    options?: { fs?: typeof fs, hooks?: Record<string, (...args: any[]) => void> },
  ) => string
  resolveOwnedSpoolDir: (spoolRoot: string, ownerId: string) => string
  resolveOwnedSpoolDirFromSave: (savePath: string, spoolRoot?: string) => string
  claimOwnedSpoolNamespaceSync: (
    savePath: string,
    spoolRoot: string,
  ) => { ownerId: string, spoolDir: string, claimPath: string }
  ensureOwnedSpoolDirSync: (spoolRoot: string, ownedSpoolDir: string) => string
  openPinnedOwnedSpoolDirSync: (
    ownedSpoolDir: string,
  ) => { descriptor: number, pinnedPath: string, stat: fs.Stats } | null
  withQuarantinedOwnedSpoolDirSync: (
    spoolRoot: string,
    ownedSpoolDir: string,
    sweep: (pinnedPath: string) => void,
    options?: { hooks?: Record<string, (...args: any[]) => void> },
  ) => { quarantined: boolean, swept: boolean }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function tempSave(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-spool-owner-'))
  tempDirs.push(root)
  const savePath = path.join(root, 'save')
  fs.mkdirSync(savePath)
  return savePath
}

function mode(filePath: string): number {
  return fs.lstatSync(filePath).mode & 0o777
}

function fsWithDirectoryFsyncError(code: string): typeof fs {
  const fsOps = Object.create(fs) as typeof fs
  fsOps.fsyncSync = ((descriptor: number) => {
    if (fs.fstatSync(descriptor).isDirectory()) {
      const error = new Error(`injected directory fsync ${code}`) as NodeJS.ErrnoException
      error.code = code
      throw error
    }
    fs.fsyncSync(descriptor)
  }) as typeof fs.fsyncSync
  return fsOps
}

describe('persistent spool ownership', () => {
  test.each(['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000'])(
    'atomically replaces invalid identity %j and reuses the winner',
    invalid => {
      const savePath = tempSave()
      const identityPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME)
      fs.writeFileSync(identityPath, invalid)

      const created = readOrCreatePersistentUuid(identityPath)

      expect(created).toMatch(UUID_PATTERN)
      expect(fs.readFileSync(identityPath, 'utf8')).toBe(created)
      expect(readOrCreatePersistentUuid(identityPath)).toBe(created)
      expect(fs.readdirSync(savePath).filter(name => (
        name.startsWith(`${SPOOL_OWNER_ID_FILENAME}.`)
      ))).toEqual([])
    },
  )

  test('separate owner UUIDs isolate copied analytics identities under one root', () => {
    const firstSave = tempSave()
    const secondSave = tempSave()
    const sharedRoot = path.join(path.dirname(firstSave), 'shared-spool')
    const copiedAnalyticsId = '62c55932-913a-4387-aa64-e1273931aa82'
    fs.writeFileSync(path.join(firstSave, '__instance_id'), copiedAnalyticsId)
    fs.writeFileSync(path.join(secondSave, '__instance_id'), copiedAnalyticsId)
    const firstOwner = readOrCreatePersistentUuid(
      path.join(firstSave, SPOOL_OWNER_ID_FILENAME),
    )
    const secondOwner = readOrCreatePersistentUuid(
      path.join(secondSave, SPOOL_OWNER_ID_FILENAME),
    )

    const firstSpool = resolveOwnedSpoolDir(sharedRoot, firstOwner)
    const secondSpool = resolveOwnedSpoolDir(sharedRoot, secondOwner)
    expect(firstSpool).not.toBe(secondSpool)
    expect(resolveOwnedSpoolDirFromSave(firstSave, sharedRoot)).toBe(firstSpool)
    expect(resolveOwnedSpoolDirFromSave(secondSave, sharedRoot)).toBe(secondSpool)
    expect(ensureOwnedSpoolDirSync(sharedRoot, firstSpool)).toBe(firstSpool)
    expect(ensureOwnedSpoolDirSync(sharedRoot, secondSpool)).toBe(secondSpool)
  })

  test('a shared-root claim reseeds a valid owner copied with a cloned save tree', () => {
    const firstSave = tempSave()
    const secondSave = tempSave()
    const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-shared-spool-'))
    tempDirs.push(sharedRoot)
    const copiedOwner = '5472d9ad-51fd-499a-a59e-a77575925785'
    fs.writeFileSync(path.join(firstSave, SPOOL_OWNER_ID_FILENAME), copiedOwner)
    fs.writeFileSync(path.join(secondSave, SPOOL_OWNER_ID_FILENAME), copiedOwner)

    const first = claimOwnedSpoolNamespaceSync(firstSave, sharedRoot)
    const second = claimOwnedSpoolNamespaceSync(secondSave, sharedRoot)
    const firstRestart = claimOwnedSpoolNamespaceSync(firstSave, sharedRoot)

    expect(first.ownerId).toBe(copiedOwner)
    expect(second.ownerId).toMatch(UUID_PATTERN)
    expect(second.ownerId).not.toBe(copiedOwner)
    expect(second.spoolDir).not.toBe(first.spoolDir)
    expect(firstRestart).toEqual(first)
    expect(fs.readFileSync(path.join(secondSave, SPOOL_OWNER_ID_FILENAME), 'utf8'))
      .toBe(second.ownerId)
  })

  test('a claim symlink is never followed and causes collision-safe reseeding', () => {
    const savePath = tempSave()
    const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-shared-spool-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-claim-target-'))
    tempDirs.push(sharedRoot, targetDir)
    const copiedOwner = '6fbdd78d-6a6d-472f-a534-f76330872cb9'
    const ownerPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME)
    fs.writeFileSync(ownerPath, copiedOwner)
    const copiedSpool = resolveOwnedSpoolDir(sharedRoot, copiedOwner)
    const copiedClaim = `${copiedSpool}.claim`
    const claimTarget = path.join(targetDir, 'claim-target')
    fs.writeFileSync(claimTarget, `v1:${'a'.repeat(64)}\n`, { mode: 0o666 })
    fs.symlinkSync(claimTarget, copiedClaim)

    const claimed = claimOwnedSpoolNamespaceSync(savePath, sharedRoot)

    expect(claimed.ownerId).not.toBe(copiedOwner)
    expect(claimed.claimPath).not.toBe(copiedClaim)
    expect(fs.readFileSync(claimTarget, 'utf8')).toBe(`v1:${'a'.repeat(64)}\n`)
    expect(fs.lstatSync(copiedClaim).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(claimed.claimPath).isFile()).toBe(true)
    expect(mode(claimed.claimPath)).toBe(0o600)
    fs.chmodSync(claimed.claimPath, 0o666)
    expect(claimOwnedSpoolNamespaceSync(savePath, sharedRoot)).toEqual(claimed)
    expect(mode(claimed.claimPath)).toBe(0o600)
  })

  test('owner symlinks are replaced while obsolete lock paths remain inert', () => {
    const savePath = tempSave()
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-owner-target-'))
    tempDirs.push(targetDir)
    const ownerTarget = path.join(targetDir, 'owner-target')
    const lockTarget = path.join(targetDir, 'lock-target')
    const victimOwner = '961a731d-019f-41a7-9f36-72a49fb6e46c'
    fs.writeFileSync(ownerTarget, victimOwner, { mode: 0o666 })
    fs.writeFileSync(lockTarget, 'victim lock contents', { mode: 0o666 })
    const ownerPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME)
    fs.symlinkSync(ownerTarget, ownerPath)
    fs.symlinkSync(lockTarget, `${ownerPath}.lock`)

    const owner = readOrCreatePersistentUuid(ownerPath)

    expect(owner).toMatch(UUID_PATTERN)
    expect(owner).not.toBe(victimOwner)
    expect(fs.readFileSync(ownerTarget, 'utf8')).toBe(victimOwner)
    expect(fs.readFileSync(lockTarget, 'utf8')).toBe('victim lock contents')
    expect(fs.lstatSync(ownerPath).isFile()).toBe(true)
    expect(fs.lstatSync(ownerPath).isSymbolicLink()).toBe(false)
    expect(mode(ownerPath)).toBe(0o600)
    expect(fs.lstatSync(`${ownerPath}.lock`).isSymbolicLink()).toBe(true)
  })

  test('valid permissive owner files and owned directories are hardened', () => {
    const savePath = tempSave()
    const ownerPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME)
    const owner = '8e2f058c-c60e-4cf5-9c8f-c610dad93ac0'
    fs.writeFileSync(ownerPath, owner, { mode: 0o666 })
    fs.chmodSync(ownerPath, 0o666)
    expect(readOrCreatePersistentUuid(ownerPath)).toBe(owner)
    expect(mode(ownerPath)).toBe(0o600)

    const root = path.join(savePath, 'spool')
    const owned = resolveOwnedSpoolDir(root, owner)
    fs.mkdirSync(owned, { recursive: true, mode: 0o777 })
    fs.chmodSync(owned, 0o777)
    ensureOwnedSpoolDirSync(root, owned)
    expect(fs.lstatSync(owned).isDirectory()).toBe(true)
    expect(fs.lstatSync(owned).isSymbolicLink()).toBe(false)
    expect(mode(owned)).toBe(0o700)
  })

  test('an owned-child symlink is repaired without sweeping its outside victim', () => {
    const savePath = tempSave()
    const root = path.join(savePath, 'spool')
    const owner = readOrCreatePersistentUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME))
    const owned = resolveOwnedSpoolDir(root, owner)
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-spool-victim-'))
    tempDirs.push(victim)
    const victimSpool = path.join(victim, '.database-risudat-victim.tmp')
    fs.writeFileSync(victimSpool, 'must survive')
    fs.mkdirSync(root)
    fs.symlinkSync(victim, owned, 'dir')

    ensureOwnedSpoolDirSync(root, owned)

    expect(fs.readFileSync(victimSpool, 'utf8')).toBe('must survive')
    expect(fs.lstatSync(owned).isDirectory()).toBe(true)
    expect(fs.lstatSync(owned).isSymbolicLink()).toBe(false)
    expect(mode(owned)).toBe(0o700)
  })

  test('identity publication never inspects or unlinks a replaced legacy lock path', () => {
    const savePath = tempSave()
    const ownerPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME)
    const lockPath = `${ownerPath}.lock`
    const replacement = JSON.stringify({
      pid: process.pid,
      token: '5dc1e6b5-1c2f-466a-8fbc-fe3ca678432d',
    })
    fs.writeFileSync(lockPath, replacement, { mode: 0o600 })
    let lockInspections = 0
    let lockUnlinks = 0
    const fsOps = Object.create(fs) as typeof fs
    fsOps.lstatSync = ((target: fs.PathLike) => {
      if (String(target) === lockPath) lockInspections += 1
      return fs.lstatSync(target)
    }) as typeof fs.lstatSync
    fsOps.unlinkSync = ((target: fs.PathLike) => {
      if (String(target) === lockPath) lockUnlinks += 1
      return fs.unlinkSync(target)
    }) as typeof fs.unlinkSync

    const returned = readOrCreatePersistentUuid(ownerPath, { fs: fsOps })

    expect(returned).toMatch(UUID_PATTERN)
    expect(fs.readFileSync(ownerPath, 'utf8')).toBe(returned)
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(replacement)
    expect(lockInspections).toBe(0)
    expect(lockUnlinks).toBe(0)
  })

  test('boot quarantine stays pinned across a directory-to-symlink path swap', () => {
    const savePath = tempSave()
    const spoolRoot = path.join(savePath, 'spool')
    const owner = readOrCreatePersistentUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME))
    const owned = resolveOwnedSpoolDir(spoolRoot, owner)
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-sweep-victim-'))
    tempDirs.push(victim)
    const victimSpool = path.join(victim, '.database-risudat-victim.tmp')
    const orphan = path.join(owned, '.database-risudat-own-orphan.tmp')
    fs.mkdirSync(owned, { recursive: true })
    fs.writeFileSync(orphan, 'own orphan')
    fs.writeFileSync(victimSpool, 'must survive')
    let parkedPath = ''

    const result = withQuarantinedOwnedSpoolDirSync(
      spoolRoot,
      owned,
      pinnedPath => {
        expect(fs.readFileSync(path.join(pinnedPath, path.basename(orphan)), 'utf8'))
          .toBe('own orphan')
        fs.unlinkSync(path.join(pinnedPath, path.basename(orphan)))
      },
      {
        hooks: {
          afterDirectoryPinned: ({ quarantinePath }: { quarantinePath: string }) => {
            parkedPath = `${quarantinePath}.parked`
            fs.renameSync(quarantinePath, parkedPath)
            fs.symlinkSync(victim, quarantinePath, 'dir')
          },
        },
      },
    )

    expect(result.swept).toBe(true)
    expect(fs.existsSync(path.join(parkedPath, path.basename(orphan)))).toBe(false)
    expect(fs.readFileSync(victimSpool, 'utf8')).toBe('must survive')
    expect(fs.lstatSync(owned).isDirectory()).toBe(true)
    fs.rmSync(parkedPath, { recursive: true, force: true })
  })

  test('post-close finalization retains an empty replacement and the parked original', () => {
    const savePath = tempSave()
    const spoolRoot = path.join(savePath, 'spool')
    const owner = readOrCreatePersistentUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME))
    const owned = resolveOwnedSpoolDir(spoolRoot, owner)
    fs.mkdirSync(owned, { recursive: true })
    fs.writeFileSync(path.join(owned, '.database-risudat-own-orphan.tmp'), 'orphan')
    let quarantinePath = ''
    let parkedPath = ''

    const result = withQuarantinedOwnedSpoolDirSync(
      spoolRoot,
      owned,
      pinnedPath => {
        fs.unlinkSync(path.join(pinnedPath, '.database-risudat-own-orphan.tmp'))
      },
      {
        hooks: {
          afterDescriptorsClosed: (details: { quarantinePath: string }) => {
            quarantinePath = details.quarantinePath
            parkedPath = `${quarantinePath}.parked`
            fs.renameSync(quarantinePath, parkedPath)
            fs.mkdirSync(quarantinePath)
          },
        },
      },
    )

    expect(result.swept).toBe(true)
    expect(fs.lstatSync(quarantinePath).isDirectory()).toBe(true)
    expect(fs.readdirSync(quarantinePath)).toEqual([])
    expect(fs.lstatSync(parkedPath).isDirectory()).toBe(true)
    expect(fs.readdirSync(parkedPath)).toEqual([])
  })

  test('pre-rename source swap never sweeps the substituted directory', () => {
    const savePath = tempSave()
    const spoolRoot = path.join(savePath, 'spool')
    const owner = readOrCreatePersistentUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME))
    const owned = resolveOwnedSpoolDir(spoolRoot, owner)
    const substituted = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-substituted-'))
    tempDirs.push(substituted)
    const victimName = '.database-risudat-substituted-victim.tmp'
    fs.mkdirSync(owned, { recursive: true })
    fs.writeFileSync(path.join(owned, 'original.keep'), 'original')
    fs.writeFileSync(path.join(substituted, victimName), 'victim')
    let parkedOriginal = ''
    let quarantinePath = ''
    let sweepCalled = false

    const result = withQuarantinedOwnedSpoolDirSync(
      spoolRoot,
      owned,
      () => { sweepCalled = true },
      {
        hooks: {
          beforeQuarantineRename: (details: { quarantinePath: string }) => {
            quarantinePath = details.quarantinePath
            parkedOriginal = `${owned}.original-parked`
            fs.renameSync(owned, parkedOriginal)
            fs.renameSync(substituted, owned)
          },
        },
      },
    )

    expect(result.swept).toBe(false)
    expect(sweepCalled).toBe(false)
    expect(fs.readFileSync(path.join(quarantinePath, victimName), 'utf8')).toBe('victim')
    expect(fs.readFileSync(path.join(parkedOriginal, 'original.keep'), 'utf8'))
      .toBe('original')
    expect(fs.lstatSync(owned).isDirectory()).toBe(true)
  })

  test('same-name fresh creation preserves both fresh and quarantined contents', () => {
    const savePath = tempSave()
    const spoolRoot = path.join(savePath, 'spool')
    const owner = readOrCreatePersistentUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME))
    const owned = resolveOwnedSpoolDir(spoolRoot, owner)
    const sameName = 'unrelated.keep'
    fs.mkdirSync(owned, { recursive: true })
    fs.writeFileSync(path.join(owned, sameName), 'old survivor')
    let quarantinePath = ''

    const result = withQuarantinedOwnedSpoolDirSync(
      spoolRoot,
      owned,
      () => {},
      {
        hooks: {
          afterDirectoryPinned: (details: {
            freshPinnedPath: string
            quarantinePath: string
          }) => {
            quarantinePath = details.quarantinePath
            fs.writeFileSync(path.join(details.freshPinnedPath, sameName), 'fresh winner', {
              flag: 'wx',
            })
          },
        },
      },
    )

    expect(result.swept).toBe(true)
    expect(fs.readFileSync(path.join(owned, sameName), 'utf8')).toBe('fresh winner')
    expect(fs.readFileSync(path.join(quarantinePath, sameName), 'utf8'))
      .toBe('old survivor')
  })

  test('runtime consumers use the pinned directory after the owned path becomes a symlink', () => {
    const savePath = tempSave()
    const spoolRoot = path.join(savePath, 'spool')
    const owner = readOrCreatePersistentUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME))
    const owned = resolveOwnedSpoolDir(spoolRoot, owner)
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-runtime-victim-'))
    tempDirs.push(victim)
    ensureOwnedSpoolDirSync(spoolRoot, owned)
    const pinned = openPinnedOwnedSpoolDirSync(owned)
    expect(pinned).not.toBeNull()
    const parked = `${owned}.parked`
    fs.renameSync(owned, parked)
    fs.symlinkSync(victim, owned, 'dir')

    fs.writeFileSync(path.join(pinned!.pinnedPath, '.database-risudat-runtime.tmp'), 'safe')
    fs.closeSync(pinned!.descriptor)

    expect(fs.readFileSync(path.join(parked, '.database-risudat-runtime.tmp'), 'utf8'))
      .toBe('safe')
    expect(fs.existsSync(path.join(victim, '.database-risudat-runtime.tmp'))).toBe(false)
  })

  test.each(['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'])(
    'treats unsupported directory fsync error %s as best effort',
    code => {
      const savePath = tempSave()
      const ownerPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME)
      const owner = readOrCreatePersistentUuid(ownerPath, {
        fs: fsWithDirectoryFsyncError(code),
      })
      expect(owner).toMatch(UUID_PATTERN)
      expect(fs.readFileSync(ownerPath, 'utf8')).toBe(owner)
    },
  )

  test('propagates a genuine directory fsync failure after durable file publication', () => {
    const savePath = tempSave()
    const ownerPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME)
    expect(() => readOrCreatePersistentUuid(ownerPath, {
      fs: fsWithDirectoryFsyncError('EIO'),
    })).toThrow('injected directory fsync EIO')
    expect(fs.readFileSync(ownerPath, 'utf8')).toMatch(UUID_PATTERN)
  })

  test('owned directory creation recovers after the configured root is repaired', () => {
    const savePath = tempSave()
    const root = path.join(savePath, 'configured-spool')
    const owner = readOrCreatePersistentUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME))
    const owned = resolveOwnedSpoolDir(root, owner)
    fs.writeFileSync(root, 'blocked')
    expect(() => ensureOwnedSpoolDirSync(root, owned)).toThrow()

    fs.unlinkSync(root)
    fs.mkdirSync(root)
    expect(ensureOwnedSpoolDirSync(root, owned)).toBe(owned)
    expect(fs.statSync(owned).isDirectory()).toBe(true)
  })
})
