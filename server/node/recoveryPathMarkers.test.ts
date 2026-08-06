import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import markerModule from './recoveryPathMarkers.cjs'

const {
    acquireRecoveryPathStateLockSync,
    addRecoveryPathMarkerKeepEntriesSync,
    assertRecoveryPathStartupQuarantineAbsentSync,
    clearRecoveryPathStartupQuarantineSync,
    fsyncDirectorySync,
    publishRecoveryPathMarkerSetSync,
    publishRecoveryPathMarkerSync,
    publishRecoveryPathStartupQuarantineSync,
    readRecoveryPathMarkerSync,
    readRecoveryPathMarkerTargetsSync,
    readRecoveryPathStartupQuarantineSync,
    recoveryPathKeepSetHas,
} = markerModule as any

const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createRoot(): Promise<{ root: string; save: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'pocketrisu-recovery-markers-'))
    tempDirs.push(root)
    const save = path.join(root, 'save')
    await mkdir(save)
    return { root, save }
}

describe('durable recovery-path marker publication', () => {
    test('publishes normalized contents through a same-directory atomic replacement', async () => {
        const { root, save } = await createRoot()
        const marker = path.join(save, '__backup_path')
        const target = path.join(root, 'data', 'backups')

        expect(publishRecoveryPathMarkerSync(marker, target)).toBe(target)
        expect(readRecoveryPathMarkerSync(marker)).toBe(target)
        await expect(readFile(marker, 'utf8')).resolves.toBe(target)
        expect((await readdir(save)).filter(name => name.endsWith('.tmp'))).toEqual([])
    })

    test('restores the previous valid marker when failure follows the atomic rename', async () => {
        const { root, save } = await createRoot()
        const marker = path.join(save, '__backup_path')
        const previous = path.join(root, 'backups')
        const replacement = path.join(root, 'data', 'backups')
        publishRecoveryPathMarkerSync(marker, previous)

        expect(() => publishRecoveryPathMarkerSync(marker, replacement, {
            onStage(stage) {
                if (stage === 'before-directory-fsync') throw new Error('injected directory fsync failure')
            },
        })).toThrow('injected directory fsync failure')

        expect(readRecoveryPathMarkerSync(marker)).toBe(previous)
        await expect(readFile(marker, 'utf8')).resolves.toBe(previous)
        expect((await readdir(save)).filter(name => name.endsWith('.tmp'))).toEqual([])
    })

    test('publishes a transition record that preserves every old and new root', async () => {
        const { root, save } = await createRoot()
        const marker = path.join(save, '__backup_path')
        const previous = path.join(root, 'old-recovery', 'backups')
        const replacement = path.join(root, 'new-recovery', 'backups')

        expect(publishRecoveryPathMarkerSetSync(marker, [previous, replacement]))
            .toEqual([previous, replacement])
        expect(readRecoveryPathMarkerTargetsSync(marker)).toEqual([previous, replacement])
        expect(() => readRecoveryPathMarkerSync(marker)).toThrow('active path transition')
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))
        const keep = addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
        })
        expect(keep.has('old-recovery')).toBe(true)
        expect(keep.has('new-recovery')).toBe(true)
    })

    test('invalidates the marker when post-rename restoration itself fails', async () => {
        const { root, save } = await createRoot()
        const marker = path.join(save, '__backup_path')
        publishRecoveryPathMarkerSync(marker, path.join(root, 'backups'))
        let temporaryCreates = 0
        const fsOps = new Proxy(fs, {
            get(target, property) {
                if (property !== 'openSync') return (target as any)[property]
                return (filePath: any, flags: any, ...args: any[]) => {
                    if (flags === 'wx' && ++temporaryCreates === 2) {
                        const error = new Error('injected rollback write failure') as NodeJS.ErrnoException
                        error.code = 'EIO'
                        throw error
                    }
                    return (target.openSync as any)(filePath, flags, ...args)
                }
            },
        })

        expect(() => publishRecoveryPathMarkerSync(marker, path.join(root, 'data', 'backups'), {
            fsOps,
            onStage(stage: string) {
                if (stage === 'before-directory-fsync') throw new Error('injected publication failure')
            },
        })).toThrow('marker was invalidated')
        expect(() => readRecoveryPathMarkerTargetsSync(marker)).toThrow('marker is missing')
    })

    test('does not blanket-ignore permission failures for POSIX directory fsync', async () => {
        const denied = new Error('permission denied') as NodeJS.ErrnoException
        denied.code = 'EACCES'
        const fsOps = {
            openSync: () => { throw denied },
            fsyncSync: () => undefined,
            closeSync: () => undefined,
        }

        expect(() => fsyncDirectorySync('/marker-parent', fsOps, { platform: 'linux' }))
            .toThrow('permission denied')
        expect(() => fsyncDirectorySync('C:\\marker-parent', fsOps, { platform: 'win32' }))
            .not.toThrow()
    })
})

describe('durable startup recovery-path quarantine', () => {
    test('preserves bounded per-marker history and blocks updater preflight until cleared', async () => {
        const { root, save } = await createRoot()
        const oldRoot = path.join(root, 'historical', 'backups')
        const currentRoot = path.join(root, 'current', 'backups')
        const chatRoot = path.join(save, 'chat-backups')

        expect(publishRecoveryPathStartupQuarantineSync(save, {
            __backup_path: [oldRoot, currentRoot],
            __chat_backup_path: [chatRoot],
        })).toEqual({
            __backup_path: [oldRoot, currentRoot],
            __chat_backup_path: [chatRoot],
        })
        expect(readRecoveryPathStartupQuarantineSync(save)?.markers).toEqual({
            __backup_path: [oldRoot, currentRoot],
            __chat_backup_path: [chatRoot],
        })
        expect(() => assertRecoveryPathStartupQuarantineAbsentSync(save))
            .toThrow('startup quarantine exists')

        clearRecoveryPathStartupQuarantineSync(save)
        expect(readRecoveryPathStartupQuarantineSync(save)).toBeNull()
        expect(() => assertRecoveryPathStartupQuarantineAbsentSync(save)).not.toThrow()
    })

    test('rejects corrupted quarantine for both startup recovery and updater preflight', async () => {
        const { root, save } = await createRoot()
        await writeFile(path.join(save, '__recovery_path_startup_quarantine'), JSON.stringify({
            version: 1,
            state: 'startup-publication-fail-closed',
            markers: { __backup_path: [path.join(root, 'old', 'backups')] },
        }))
        await writeFile(path.join(save, '__backup_path'), path.join(root, 'backups'))
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))

        expect(() => readRecoveryPathStartupQuarantineSync(save))
            .toThrow('unsupported schema')
        expect(() => addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
        })).toThrow('startup quarantine exists')
    })
})

describe('cross-process recovery-path state lock', () => {
    test('excludes a second owner until the exact token releases the durable lock', async () => {
        const { save } = await createRoot()
        const first = acquireRecoveryPathStateLockSync(save, { purpose: 'first test owner' })

        expect(() => acquireRecoveryPathStateLockSync(save, { purpose: 'second test owner' }))
            .toThrow('locked by owner pid')
        expect(() => first.release()).not.toThrow()

        const second = acquireRecoveryPathStateLockSync(save, { purpose: 'second test owner' })
        expect(() => second.release()).not.toThrow()
    })

    test('fails closed instead of guessing that incomplete crash-stale ownership is safe', async () => {
        const { save } = await createRoot()
        const lockPath = path.join(save, '__recovery_path_state.lock')
        await mkdir(lockPath)

        expect(() => acquireRecoveryPathStateLockSync(save, { purpose: 'replacement' }))
            .toThrow('never removed automatically')
        expect(await readdir(lockPath)).toEqual([])
    })
})

describe('updater recovery-path marker preflight', () => {
    test('preserves safe in-tree roots while defaults and outside-root paths stay valid', async () => {
        const { root, save } = await createRoot()
        const external = path.join(path.dirname(root), 'external-chat-history')
        await writeFile(path.join(save, '__backup_path'), path.join(root, 'recovery', 'server'))
        await writeFile(path.join(save, '__chat_backup_path'), external)
        const kept: Array<[string, string]> = []
        const keep = new Set(['save', 'backups'])

        addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep,
            onKeep: (entry, label) => kept.push([entry, label]),
        })

        expect([...keep]).toEqual(['save', 'backups', 'recovery'])
        expect(kept).toEqual([['recovery', 'Server-backup directory']])
    })

    test('does not mistake an in-tree dot-prefixed directory for a parent traversal', async () => {
        const { root, save } = await createRoot()
        await writeFile(path.join(save, '__backup_path'), path.join(root, '..recovery', 'server'))
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))
        const keep = new Set(['save', 'backups'])

        addRecoveryPathMarkerKeepEntriesSync({ root, keep })

        expect(keep.has('..recovery')).toBe(true)
    })

    test.each([
        ['missing', async (marker: string) => { await rm(marker, { force: true }) }, 'marker is missing'],
        ['non-regular', async (marker: string) => { await mkdir(marker) }, 'not a regular file'],
        ['empty', async (marker: string) => { await writeFile(marker, '') }, 'invalid size'],
        ['relative', async (marker: string) => { await writeFile(marker, 'data/backups') }, 'not absolute'],
    ])('rejects a %s marker before replacement', async (_name, arrange, message) => {
        const { root, save } = await createRoot()
        const serverMarker = path.join(save, '__backup_path')
        await arrange(serverMarker)
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))

        expect(() => addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
        })).toThrow(message)
    })

    test('rejects symlink and managed-root markers before replacement', async () => {
        const { root, save } = await createRoot()
        const target = path.join(save, 'marker-target')
        await writeFile(target, path.join(root, 'data', 'backups'))
        await symlink(target, path.join(save, '__backup_path'))
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))

        expect(() => addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
        })).toThrow('not a regular file')

        await rm(path.join(save, '__backup_path'))
        await writeFile(path.join(save, '__backup_path'), path.join(root, 'server', 'backups'))
        expect(() => addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
        })).toThrow('inside PocketRisu app files')
    })

    test('resolves outside symlink aliases into the app before classifying them', async () => {
        const { root: container } = await createRoot()
        const root = path.join(container, 'app')
        const save = path.join(root, 'save')
        await mkdir(path.join(root, 'server'), { recursive: true })
        await mkdir(path.join(root, 'recovery'), { recursive: true })
        await mkdir(save, { recursive: true })
        const alias = path.join(container, 'outside-alias')
        await symlink(path.join(root, 'server'), alias, 'dir')
        await writeFile(path.join(save, '__backup_path'), path.join(alias, 'backups'))
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))

        expect(() => addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
        })).toThrow('inside PocketRisu app files')

        await rm(alias)
        await symlink(path.join(root, 'recovery'), alias, 'dir')
        const keep = addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
        })
        expect(keep.has('recovery')).toBe(true)
    })

    test('applies Windows case folding to managed-root admission', async () => {
        const { root, save } = await createRoot()
        await writeFile(path.join(save, '__backup_path'), path.join(root, 'SERVER', 'backups'))
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))

        expect(() => addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
            platform: 'win32',
        })).toThrow('inside PocketRisu app files')
    })

    test('preserves filesystem casing for safe Windows keep entries and compares them case-insensitively', async () => {
        const { root, save } = await createRoot()
        await writeFile(
            path.join(save, '__backup_path'),
            path.join(root, 'RecoveryData', 'backups'),
        )
        await writeFile(path.join(save, '__chat_backup_path'), path.join(save, 'chat-backups'))

        const keep = addRecoveryPathMarkerKeepEntriesSync({
            root,
            keep: new Set(['save', 'backups']),
            platform: 'win32',
        })

        expect(keep.has('RecoveryData')).toBe(true)
        expect(keep.has('recoverydata')).toBe(false)
        expect(recoveryPathKeepSetHas(keep, 'RECOVERYDATA', 'win32')).toBe(true)
    })
})
