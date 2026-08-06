import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import markerModule from './recoveryPathMarkers.cjs'

const updaterSource = path.resolve(import.meta.dirname, '../../scripts/updater.cjs')
const markerModuleSource = path.resolve(import.meta.dirname, 'recoveryPathMarkers.cjs')
const finalizerSource = path.resolve(import.meta.dirname, '../../scripts/recoveryPathLockFinalizer.cjs')
const {
    acquireRecoveryPathStateLockSync,
} = markerModule as any
const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createHarness(chatMarker: 'valid' | 'missing' | 'non-regular' | 'malformed') {
    const root = await mkdtemp(path.join(tmpdir(), 'pocketrisu-portable-updater-'))
    tempDirs.push(root)
    await mkdir(path.join(root, 'scripts'), { recursive: true })
    await mkdir(path.join(root, 'server', 'node'), { recursive: true })
    await mkdir(path.join(root, 'save'), { recursive: true })
    await copyFile(updaterSource, path.join(root, 'scripts', 'updater.cjs'))
    await copyFile(markerModuleSource, path.join(root, 'server', 'node', 'recoveryPathMarkers.cjs'))
    await writeFile(path.join(root, '.installed-version'), 'v-old')
    await writeFile(path.join(root, 'old-release.txt'), 'old release')
    await writeFile(path.join(root, 'save', '__backup_path'), path.join(root, 'backups'))
    if (chatMarker === 'non-regular') {
        await mkdir(path.join(root, 'save', '__chat_backup_path'))
    } else if (chatMarker === 'malformed') {
        await writeFile(path.join(root, 'save', '__chat_backup_path'), 'history/chat-backups')
    } else if (chatMarker === 'valid') {
        await writeFile(
            path.join(root, 'save', '__chat_backup_path'),
            path.join(root, 'save', 'chat-backups'),
        )
    }
    return root
}

describe('standalone portable updater recovery preflight', () => {
    test.each([
        ['missing', 'marker is missing'],
        ['non-regular', 'not a regular file'],
        ['malformed', 'not absolute'],
    ] as const)('fails closed for a %s marker before network or replacement', async (kind, message) => {
        const root = await createHarness(kind)

        const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'updater.cjs')], {
            cwd: root,
            encoding: 'utf8',
        })

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(message)
        expect(result.stdout).not.toContain('Checking for updates')
        await expect(readFile(path.join(root, 'old-release.txt'), 'utf8')).resolves.toBe('old release')
    })

    test('fails closed for an incomplete crash-stale interprocess lock', async () => {
        const root = await createHarness('valid')
        await mkdir(path.join(root, 'save', '__recovery_path_state.lock'))

        const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'updater.cjs')], {
            cwd: root,
            encoding: 'utf8',
        })

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('never removed automatically')
        expect(result.stdout).not.toContain('Checking for updates')
        await expect(readFile(path.join(root, 'old-release.txt'), 'utf8')).resolves.toBe('old release')
    })

    test('successful destructive replacement preserves transition roots and a mixed-case Windows keep entry', async () => {
        const root = await createHarness('missing')
        const oldRecovery = path.join(root, 'RecoveryData', 'server')
        const newRecovery = path.join(root, 'new-recovery', 'server')
        const chatRecovery = path.join(root, 'chat-history')
        await mkdir(oldRecovery, { recursive: true })
        await mkdir(newRecovery, { recursive: true })
        await mkdir(chatRecovery, { recursive: true })
        await writeFile(path.join(oldRecovery, 'old.bin'), 'old recovery')
        await writeFile(path.join(newRecovery, 'new.bin'), 'new recovery')
        await writeFile(path.join(chatRecovery, 'chat.gz'), 'chat recovery')
        await writeFile(path.join(root, 'save', '__backup_path'), JSON.stringify({
            version: 1,
            paths: [oldRecovery, newRecovery],
        }))
        await writeFile(path.join(root, 'save', '__chat_backup_path'), chatRecovery)

        const fixtureRoot = path.join(root, 'fixture')
        const releaseDir = path.join(fixtureRoot, 'PocketRisu-v-new')
        await mkdir(path.join(releaseDir, 'dist'), { recursive: true })
        await mkdir(path.join(releaseDir, 'server', 'node'), { recursive: true })
        await writeFile(path.join(releaseDir, 'dist', 'index.html'), '<html>new</html>')
        await writeFile(path.join(releaseDir, 'server', 'node', 'server.cjs'), '// new server')
        await copyFile(markerModuleSource, path.join(releaseDir, 'server', 'node', 'recoveryPathMarkers.cjs'))
        await writeFile(path.join(releaseDir, 'package.json'), '{"version":"2.0.0"}\n')
        await writeFile(path.join(releaseDir, 'new-release.txt'), 'new release')
        const assetName = `PocketRisu-vnew-${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch}.tar.gz`
        const assetPath = path.join(root, assetName)
        const tar = spawnSync('tar', ['-czf', assetPath, '-C', fixtureRoot, path.basename(releaseDir)], {
            encoding: 'utf8',
        })
        expect(tar.status, tar.stderr).toBe(0)
        const releaseJson = path.join(root, 'release.json')
        await writeFile(releaseJson, JSON.stringify({
            tag_name: 'v-new',
            assets: [{ name: assetName, browser_download_url: 'fixture://asset' }],
        }))

        const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'updater.cjs')], {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                NODE_ENV: 'test',
                POCKETRISU_TEST_RECOVERY_PLATFORM: 'win32',
                POCKETRISU_TEST_WINDOWS_LOCK_HANDOFF: 'true',
                POCKETRISU_TEST_UPDATER_RELEASE_JSON_PATH: releaseJson,
                POCKETRISU_TEST_UPDATER_ASSET_PATH: assetPath,
            },
        })

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        const handoffPath = path.join(root, '.update-tmp', 'recovery-path-lock-handoff.json')
        await expect(readFile(handoffPath, 'utf8')).resolves.toContain(path.join(root, 'save'))
        expect(() => acquireRecoveryPathStateLockSync(path.join(root, 'save'), {
            purpose: 'post-parent contender',
        })).toThrow('standalone portable updater')
        const finalized = spawnSync(process.execPath, [finalizerSource, handoffPath], {
            cwd: root,
            encoding: 'utf8',
        })
        expect(finalized.status, finalized.stderr).toBe(0)
        const nextOwner = acquireRecoveryPathStateLockSync(path.join(root, 'save'), {
            purpose: 'next operation',
        })
        nextOwner.release()
        await expect(readFile(path.join(root, 'new-release.txt'), 'utf8')).resolves.toBe('new release')
        await expect(readFile(path.join(oldRecovery, 'old.bin'), 'utf8')).resolves.toBe('old recovery')
        await expect(readFile(path.join(newRecovery, 'new.bin'), 'utf8')).resolves.toBe('new recovery')
        await expect(readFile(path.join(chatRecovery, 'chat.gz'), 'utf8')).resolves.toBe('chat recovery')
        await expect(readFile(path.join(root, 'old-release.txt'), 'utf8')).rejects.toThrow()
    })
})
