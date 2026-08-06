import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from './assetMaintenanceLock.cjs'

const {
  acquireAssetMaintenanceLockSync,
  assetMaintenanceLockPath,
  canonicalAssetDirectoryIdentitySync,
  readAssetMaintenanceLockOwnerSync,
  releaseAssetMaintenanceLockSync,
  sameAssetDirectoryIdentitySync,
  withAssetMaintenanceLockSync,
} = pkg as {
  acquireAssetMaintenanceLockSync: (
    assetDir: string,
    options?: {
      hostname?: string
      pid?: number
      pidIsAlive?: (pid: number) => boolean
      purpose?: string
      onStage?: (
        stage: string,
        detail?: { lockPath: string; token: string },
      ) => void
      fsOps?: typeof fs
    },
  ) => { assetDir: string; lockPath: string; token: string; release: () => void }
  assetMaintenanceLockPath: (assetDir: string) => string
  canonicalAssetDirectoryIdentitySync: (assetDir: string) => string
  readAssetMaintenanceLockOwnerSync: (
    lockPath: string,
  ) => { token: string; pid: number; purpose: string } | null
  releaseAssetMaintenanceLockSync: (assetDir: string, token: string) => boolean
  sameAssetDirectoryIdentitySync: (left: string, right: string) => boolean
  withAssetMaintenanceLockSync: <T>(
    assetDir: string,
    operation: () => T,
    options?: { fsOps?: typeof fs },
  ) => T
}

const roots: string[] = []

function makeAssetDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-asset-lock-'))
  roots.push(root)
  const assetDir = path.join(root, 'save', 'assets')
  fs.mkdirSync(assetDir, { recursive: true })
  return assetDir
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function waitForFile(filePath: string) {
  const deadline = Date.now() + 5_000
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForCondition(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
}

describe('asset maintenance lock', () => {
  it('excludes another process contract and releases by ownership token', () => {
    const assetDir = makeAssetDir()
    const first = acquireAssetMaintenanceLockSync(assetDir, { purpose: 'first' })

    expect(() => acquireAssetMaintenanceLockSync(assetDir, { purpose: 'second' }))
      .toThrow(/locked by owner pid/)
    expect(readAssetMaintenanceLockOwnerSync(first.lockPath)?.token).toBe(first.token)

    first.release()
    expect(readAssetMaintenanceLockOwnerSync(first.lockPath)).toBeNull()
    const second = acquireAssetMaintenanceLockSync(assetDir, { purpose: 'second' })
    second.release()
  })

  it('recovers a valid dead same-host owner but fails closed for a foreign host', () => {
    const assetDir = makeAssetDir()
    acquireAssetMaintenanceLockSync(assetDir, {
      hostname: 'same-test-host',
      pid: 424242,
      purpose: 'crashed dedup',
    })

    const recovered = acquireAssetMaintenanceLockSync(assetDir, {
      hostname: 'same-test-host',
      pidIsAlive: () => false,
      purpose: 'recovery',
    })
    expect(readAssetMaintenanceLockOwnerSync(recovered.lockPath)?.purpose).toBe('recovery')
    recovered.release()

    acquireAssetMaintenanceLockSync(assetDir, {
      hostname: 'foreign-host',
      pid: 434343,
      purpose: 'foreign owner',
    })
    expect(() => acquireAssetMaintenanceLockSync(assetDir, {
      hostname: 'same-test-host',
      pidIsAlive: () => false,
    })).toThrow(/foreign-host/)
  })

  it('gives fail-closed operator guidance for malformed owner metadata', () => {
    const assetDir = makeAssetDir()
    const lockPath = assetMaintenanceLockPath(assetDir)
    fs.mkdirSync(lockPath)
    fs.writeFileSync(path.join(lockPath, 'owner.json'), '{malformed')

    expect(() => acquireAssetMaintenanceLockSync(assetDir)).toThrow(
      /cannot be recovered automatically.*remove only.*owner\.json/,
    )
  })

  it('places the coordinator beside assets so directory swaps cannot move it', () => {
    const assetDir = makeAssetDir()
    expect(assetMaintenanceLockPath(assetDir)).toBe(
      path.join(path.dirname(assetDir), '__asset_maintenance.lock'),
    )
  })

  it('canonicalizes ancestor symlinks while rejecting a symlinked assets leaf', () => {
    const assetDir = makeAssetDir()
    const root = path.dirname(path.dirname(assetDir))
    const aliasSave = path.join(root, 'save-alias')
    fs.symlinkSync(path.dirname(assetDir), aliasSave, 'dir')
    const aliasAssetDir = path.join(aliasSave, 'assets')

    expect(canonicalAssetDirectoryIdentitySync(aliasAssetDir)).toBe(assetDir)
    expect(assetMaintenanceLockPath(aliasAssetDir)).toBe(assetMaintenanceLockPath(assetDir))
    expect(sameAssetDirectoryIdentitySync(aliasAssetDir, assetDir)).toBe(true)

    const leafAlias = path.join(root, 'assets-alias')
    fs.symlinkSync(assetDir, leafAlias, 'dir')
    expect(() => acquireAssetMaintenanceLockSync(leafAlias))
      .toThrow(/must not be a symbolic link/)
  })

  it.each([
    'owner-created-before-fstat',
    'after-owner-open',
    'before-owner-fsync',
    'before-coordinator-fsync',
    'before-owner-postcheck',
  ])('does not strand live ownership after acquisition failure at %s', (failureStage) => {
    const assetDir = makeAssetDir()
    expect(() => acquireAssetMaintenanceLockSync(assetDir, {
      onStage(stage) {
        if (stage === failureStage) throw new Error(`injected ${failureStage} failure`)
      },
    })).toThrow(`injected ${failureStage} failure`)

    expect(readAssetMaintenanceLockOwnerSync(assetMaintenanceLockPath(assetDir))).toBeNull()
    const retry = acquireAssetMaintenanceLockSync(assetDir)
    retry.release()
  })

  it('never publishes live ownership when the staged inode fstat step fails', () => {
    const assetDir = makeAssetDir()
    const fsImpl = Object.create(fs) as typeof fs
    const realFstat = fs.fstatSync.bind(fs)
    let injected = false
    fsImpl.fstatSync = ((descriptor: number) => {
      if (!injected) {
        injected = true
        const error = new Error('injected owner fstat failure') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      return realFstat(descriptor)
    }) as typeof fs.fstatSync

    expect(() => acquireAssetMaintenanceLockSync(assetDir, { fsOps: fsImpl }))
      .toThrow('injected owner fstat failure')
    expect(injected).toBe(true)
    const lockPath = assetMaintenanceLockPath(assetDir)
    expect(readAssetMaintenanceLockOwnerSync(lockPath)).toBeNull()
    expect(fs.readdirSync(lockPath).filter(name => name.startsWith('.owner-stage-')))
      .toHaveLength(1)

    const retry = acquireAssetMaintenanceLockSync(assetDir)
    retry.release()
    expect(fs.readdirSync(lockPath).filter(name => name.startsWith('.owner-stage-')))
      .toEqual([])
  })

  it('cleans a fully published owner after lstat fails immediately after publication', () => {
    const assetDir = makeAssetDir()
    const fsImpl = Object.create(fs) as typeof fs
    const realLstat = fs.lstatSync.bind(fs)
    const ownerPath = path.join(assetMaintenanceLockPath(assetDir), 'owner.json')
    let injected = false
    fsImpl.lstatSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
      if (!injected
          && path.resolve(String(target)) === path.resolve(ownerPath)
          && fs.existsSync(ownerPath)) {
        injected = true
        const error = new Error('injected post-publication owner lstat failure') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      return realLstat(target, options as never)
    }) as typeof fs.lstatSync

    expect(() => acquireAssetMaintenanceLockSync(assetDir, { fsOps: fsImpl }))
      .toThrow('Asset-maintenance lock ownership changed during publication')
    expect(injected).toBe(true)
    expect(fs.existsSync(ownerPath)).toBe(false)

    const retry = acquireAssetMaintenanceLockSync(assetDir)
    retry.release()
  })

  it('never removes a replacement inode merely because it copied the same token', () => {
    const assetDir = makeAssetDir()
    const ownerPath = path.join(assetMaintenanceLockPath(assetDir), 'owner.json')
    let originalInode: number | null = null
    let replacementInode: number | null = null
    let publishedToken: string | null = null
    const primary = new Error('injected same-token replacement') as Error & {
      cleanupErrors?: Error[]
    }

    expect(() => acquireAssetMaintenanceLockSync(assetDir, {
      onStage(stage, detail) {
        if (stage !== 'after-owner-open') return
        publishedToken = detail!.token
        const copiedMetadata = fs.readFileSync(ownerPath)
        originalInode = fs.statSync(ownerPath).ino
        fs.unlinkSync(ownerPath)
        fs.writeFileSync(ownerPath, copiedMetadata, { flag: 'wx', mode: 0o600 })
        replacementInode = fs.statSync(ownerPath).ino
        throw primary
      },
    })).toThrow(primary)

    expect(replacementInode).not.toBe(originalInode)
    expect(fs.statSync(ownerPath).ino).toBe(replacementInode)
    expect(readAssetMaintenanceLockOwnerSync(assetMaintenanceLockPath(assetDir))?.token)
      .toBe(publishedToken)
    expect(primary.cleanupErrors?.some(error => /ownership changed/.test(error.message)))
      .toBe(true)

    fs.unlinkSync(ownerPath)
    const retry = acquireAssetMaintenanceLockSync(assetDir)
    retry.release()
  })

  it('refuses cleanup when the exact created inode has corrupted owner metadata', () => {
    const assetDir = makeAssetDir()
    const ownerPath = path.join(assetMaintenanceLockPath(assetDir), 'owner.json')
    const primary = new Error('injected in-place owner corruption') as Error & {
      cleanupErrors?: Error[]
    }

    expect(() => acquireAssetMaintenanceLockSync(assetDir, {
      onStage(stage) {
        if (stage !== 'after-owner-open') return
        fs.truncateSync(ownerPath, 0)
        throw primary
      },
    })).toThrow(primary)

    expect(fs.statSync(ownerPath).size).toBe(0)
    expect(primary.cleanupErrors?.some(error => /exact token is unavailable/.test(error.message)))
      .toBe(true)
    fs.unlinkSync(ownerPath)
    const retry = acquireAssetMaintenanceLockSync(assetDir)
    retry.release()
  })

  it('preserves a recovery primary error when same-owner release also fails', () => {
    const assetDir = makeAssetDir()
    const fsImpl = Object.create(fs) as typeof fs
    const realUnlink = fs.unlinkSync.bind(fs)
    let failOwnerRelease = false
    fsImpl.unlinkSync = ((target: fs.PathLike) => {
      if (failOwnerRelease && path.basename(String(target)) === 'owner.json') {
        throw new Error('injected recovery release failure')
      }
      return realUnlink(target)
    }) as typeof fs.unlinkSync
    const primary = new Error('injected import recovery failure') as Error & {
      cleanupErrors?: Error[]
    }

    failOwnerRelease = true
    expect(() => withAssetMaintenanceLockSync(
      assetDir,
      () => { throw primary },
      { fsOps: fsImpl },
    )).toThrow(primary)
    expect(primary.cleanupErrors?.map(error => error.message)).toEqual([
      'injected recovery release failure',
      'injected recovery release failure',
    ])

    failOwnerRelease = false
    const owner = readAssetMaintenanceLockOwnerSync(assetMaintenanceLockPath(assetDir))
    expect(owner).not.toBeNull()
    releaseAssetMaintenanceLockSync(assetDir, owner!.token)
  })

  it('never lets a stale token release a newer owner and makes same-owner cleanup idempotent', () => {
    const assetDir = makeAssetDir()
    const lock = acquireAssetMaintenanceLockSync(assetDir)
    const staleToken = '0'.repeat(64)

    expect(() => releaseAssetMaintenanceLockSync(assetDir, staleToken))
      .toThrow(/ownership token does not match/)
    expect(readAssetMaintenanceLockOwnerSync(lock.lockPath)?.token).toBe(lock.token)
    expect(releaseAssetMaintenanceLockSync(assetDir, lock.token)).toBe(true)
    expect(releaseAssetMaintenanceLockSync(assetDir, lock.token)).toBe(false)
  })

  it('excludes a truly simultaneous contender process', async () => {
    const assetDir = makeAssetDir()
    const root = path.dirname(path.dirname(assetDir))
    const ready = path.join(root, 'ready')
    const release = path.join(root, 'release')
    const helperPath = path.resolve('server/node/assets/assetMaintenanceLock.cjs')
    const holderCode = `
      const fs = require('fs');
      const helper = require(${JSON.stringify(helperPath)});
      const lock = helper.acquireAssetMaintenanceLockSync(${JSON.stringify(assetDir)}, { purpose: 'holder child' });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        lock.release();
      }, 10);
    `
    const holder = spawn(process.execPath, ['-e', holderCode], { stdio: 'pipe' })
    await waitForFile(ready)

    const contenderCode = `
      const helper = require(${JSON.stringify(helperPath)});
      try {
        helper.acquireAssetMaintenanceLockSync(${JSON.stringify(assetDir)}, { purpose: 'contender child' });
        process.exit(0);
      } catch (error) {
        process.exit(error?.code === 'ASSET_MAINTENANCE_LOCKED' ? 4 : 5);
      }
    `
    const contender = spawnSync(process.execPath, ['-e', contenderCode])
    expect(contender.status).toBe(4)

    fs.writeFileSync(release, 'release')
    const holderExit = await new Promise<number | null>((resolve, reject) => {
      holder.once('error', reject)
      holder.once('exit', resolve)
    })
    expect(holderExit).toBe(0)
  })

  it('reconciles a killed published-owner stage before stale-owner recovery', () => {
    const assetDir = makeAssetDir()
    const helperPath = path.resolve('server/node/assets/assetMaintenanceLock.cjs')
    const killed = spawnSync(process.execPath, ['-e', `
      const helper = require(${JSON.stringify(helperPath)});
      helper.acquireAssetMaintenanceLockSync(${JSON.stringify(assetDir)}, {
        purpose: 'killed staged owner',
        onStage(stage) {
          if (stage === 'after-owner-open') process.kill(process.pid, 'SIGKILL');
        },
      });
    `])
    expect(killed.signal).toBe('SIGKILL')
    const lockPath = assetMaintenanceLockPath(assetDir)
    expect(fs.readdirSync(lockPath).some(name => name.startsWith('.owner-stage-')))
      .toBe(true)

    const recovered = acquireAssetMaintenanceLockSync(assetDir, {
      purpose: 'post-kill recovery',
    })
    expect(readAssetMaintenanceLockOwnerSync(lockPath)?.token).toBe(recovered.token)
    expect(fs.readdirSync(lockPath).filter(name => name.startsWith('.owner-stage-')))
      .toEqual([])
    recovered.release()
  })

  it('does not steal a normal in-progress owner stage', async () => {
    const assetDir = makeAssetDir()
    const root = path.dirname(path.dirname(assetDir))
    const ready = path.join(root, 'stage-ready')
    const proceed = path.join(root, 'stage-proceed')
    const acquired = path.join(root, 'stage-acquired')
    const helperPath = path.resolve('server/node/assets/assetMaintenanceLock.cjs')
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const helper = require(${JSON.stringify(helperPath)});
      const lock = helper.acquireAssetMaintenanceLockSync(${JSON.stringify(assetDir)}, {
        purpose: 'active staged owner',
        onStage(stage) {
          if (stage !== 'owner-created-before-fstat') return;
          fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
          while (!fs.existsSync(${JSON.stringify(proceed)})) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        },
      });
      fs.writeFileSync(${JSON.stringify(acquired)}, lock.token);
      lock.release();
    `], { stdio: 'pipe' })
    await waitForFile(ready)
    const lockPath = assetMaintenanceLockPath(assetDir)
    const childStage = fs.readdirSync(lockPath).find(name => name.startsWith('.owner-stage-'))
    expect(childStage).toBeTruthy()

    const parent = acquireAssetMaintenanceLockSync(assetDir, { purpose: 'stage observer' })
    expect(fs.existsSync(path.join(lockPath, childStage!))).toBe(true)
    parent.release()
    fs.writeFileSync(proceed, 'proceed')
    expect(await waitForExit(child)).toBe(0)
    expect(fs.existsSync(acquired)).toBe(true)
  })

  it('elects one concurrent stale remover and never unlinks its replacement owner', async () => {
    const assetDir = makeAssetDir()
    const root = path.dirname(path.dirname(assetDir))
    const helperPath = path.resolve('server/node/assets/assetMaintenanceLock.cjs')
    const stale = spawnSync(process.execPath, ['-e', `
      const helper = require(${JSON.stringify(helperPath)});
      helper.acquireAssetMaintenanceLockSync(${JSON.stringify(assetDir)}, {
        purpose: 'stale concurrent owner',
        onStage(stage) {
          if (stage === 'owner-published') process.kill(process.pid, 'SIGKILL');
        },
      });
    `])
    expect(stale.signal).toBe('SIGKILL')

    const start = path.join(root, 'recovery-start')
    const release = path.join(root, 'recovery-release')
    const contender = (id: number) => spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const helper = require(${JSON.stringify(helperPath)});
      while (!fs.existsSync(${JSON.stringify(start)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      try {
        const lock = helper.acquireAssetMaintenanceLockSync(${JSON.stringify(assetDir)}, {
          purpose: 'concurrent stale contender ${id}',
        });
        fs.writeFileSync(${JSON.stringify(path.join(root, `winner-${id}`))}, lock.token);
        while (!fs.existsSync(${JSON.stringify(release)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        lock.release();
        process.exit(0);
      } catch (error) {
        fs.writeFileSync(${JSON.stringify(path.join(root, `loser-${id}`))}, error?.code || 'unknown');
        process.exit(error?.code === 'ASSET_MAINTENANCE_LOCKED' ? 4 : 5);
      }
    `], { stdio: 'pipe' })
    const first = contender(1)
    const second = contender(2)
    fs.writeFileSync(start, 'start')
    await waitForCondition(() => {
      const winners = [1, 2].filter(id => fs.existsSync(path.join(root, `winner-${id}`)))
      const losers = [1, 2].filter(id => fs.existsSync(path.join(root, `loser-${id}`)))
      return winners.length === 1 && losers.length === 1
    }, 'one stale-recovery winner and one loser')

    const winnerId = fs.existsSync(path.join(root, 'winner-1')) ? 1 : 2
    const winnerToken = fs.readFileSync(path.join(root, `winner-${winnerId}`), 'utf8')
    expect(readAssetMaintenanceLockOwnerSync(assetMaintenanceLockPath(assetDir))?.token)
      .toBe(winnerToken)
    expect(() => acquireAssetMaintenanceLockSync(assetDir, { purpose: 'third contender' }))
      .toThrow(/locked by owner pid/)

    fs.writeFileSync(release, 'release')
    const exits = await Promise.all([waitForExit(first), waitForExit(second)])
    expect(exits.sort()).toEqual([0, 4])
  })
})
