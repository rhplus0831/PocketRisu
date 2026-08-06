import { spawn, spawnSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import markerModule from './recoveryPathMarkers.cjs'

const {
    RECOVERY_PATH_STATE_HANDOFF_NAME,
    acquireRecoveryPathStateLockSync,
    publishRecoveryPathStateLockHandoffSync,
} = markerModule as any

const helperSource = path.resolve(import.meta.dirname, 'recoveryPathMarkers.cjs')
const finalizerSource = path.resolve(import.meta.dirname, '../../scripts/recoveryPathLockFinalizer.cjs')
const batchTemplate = path.resolve(import.meta.dirname, '../../scripts/windows-update.bat')
const releaseWorkflow = path.resolve(import.meta.dirname, '../../.github/workflows/release.yml')
const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function waitForPath(filePath: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try { await access(filePath); return } catch {}
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for ${filePath}`)
}

describe('Windows recovery-path lock finalization', () => {
    test('holds the original token through the post-step gate and releases exactly once', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pocketrisu-windows-finalizer-'))
        tempDirs.push(root)
        const save = path.join(root, 'save')
        const updateTmp = path.join(root, '.update-tmp')
        const gateDir = path.join(root, 'gate')
        await mkdir(save)
        await mkdir(updateTmp)
        await mkdir(gateDir)
        await mkdir(path.join(root, 'scripts'))
        await mkdir(path.join(root, 'server', 'node'), { recursive: true })
        await copyFile(helperSource, path.join(root, 'server', 'node', 'recoveryPathMarkers.cjs'))
        await copyFile(finalizerSource, path.join(root, 'scripts', 'recoveryPathLockFinalizer.cjs'))
        await writeFile(path.join(gateDir, 'stage'), 'windows-finalizer-before-release')
        await writeFile(path.join(gateDir, 'hold'), 'hold')

        const owner = acquireRecoveryPathStateLockSync(save, {
            purpose: 'Windows updater parent',
        })
        const handoffPath = path.join(updateTmp, RECOVERY_PATH_STATE_HANDOFF_NAME)
        publishRecoveryPathStateLockHandoffSync(handoffPath, save, owner.token)
        const finalizer = spawn(
            process.execPath,
            [path.join(root, 'scripts', 'recoveryPathLockFinalizer.cjs'), handoffPath],
            {
                cwd: root,
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    POCKETRISU_TEST_WINDOWS_FINALIZER_GATE_DIR: gateDir,
                },
                stdio: ['ignore', 'ignore', 'pipe'],
            },
        )
        let stderr = ''
        finalizer.stderr?.on('data', chunk => { stderr += chunk.toString() })
        await waitForPath(path.join(gateDir, 'entered'))

        expect(() => acquireRecoveryPathStateLockSync(save, {
            purpose: 'second server/updater',
        })).toThrow('Windows updater parent')
        await expect(readFile(handoffPath, 'utf8')).resolves.toContain(owner.token)

        await rm(path.join(gateDir, 'hold'))
        await writeFile(path.join(gateDir, 'release'), 'release')
        const exitCode = await new Promise<number | null>((resolve, reject) => {
            finalizer.once('error', reject)
            finalizer.once('exit', resolve)
        })
        expect(exitCode, stderr).toBe(0)
        await expect(readFile(handoffPath, 'utf8')).rejects.toThrow()
        expect(() => owner.release()).toThrow('ownership token does not match')

        const next = acquireRecoveryPathStateLockSync(save, { purpose: 'next operation' })
        next.release()
    })

    test('packaged batch finalizes the lock after bin/version work and release includes both scripts', async () => {
        const batch = await readFile(batchTemplate, 'utf8')
        const workflow = await readFile(releaseWorkflow, 'utf8')
        const xcopy = batch.indexOf('xcopy /E /I /Y')
        const versionCopy = batch.indexOf('copy /Y "%~dp0.update-tmp\\latest-version"')
        const releaseCall = batch.indexOf('call :release_recovery_lock')
        const finalizer = batch.indexOf('recoveryPathLockFinalizer.cjs')
        const cleanup = batch.indexOf('rmdir /s /q')

        expect(xcopy).toBeGreaterThanOrEqual(0)
        expect(versionCopy).toBeGreaterThan(xcopy)
        expect(releaseCall).toBeGreaterThan(versionCopy)
        expect(cleanup).toBeGreaterThan(releaseCall)
        expect(finalizer).toBeGreaterThanOrEqual(0)
        expect(batch).toContain(':fail\ncall :release_recovery_lock')
        expect(workflow).toContain('cp scripts/windows-update.bat portable/update.bat')
        expect(workflow).toContain('cp scripts/recoveryPathLockFinalizer.cjs portable/scripts/recoveryPathLockFinalizer.cjs')

        const projectRoot = path.resolve(import.meta.dirname, '../..')
        const releaseSources = [
            'scripts/windows-update.bat',
            'scripts/recoveryPathLockFinalizer.cjs',
        ]
        const ignored = spawnSync('git', ['check-ignore', '--', ...releaseSources], {
            cwd: projectRoot,
            encoding: 'utf8',
        })
        expect(ignored.status, ignored.stdout + ignored.stderr).toBe(1)
        const visible = spawnSync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...releaseSources],
            { cwd: projectRoot, encoding: 'utf8' },
        )
        expect(visible.status, visible.stderr).toBe(0)
        expect(visible.stdout.trim().split('\n').sort()).toEqual([...releaseSources].sort())

        // Exercise the workflow's portable-layout copies using only sources
        // that a clean checkout can track.
        const packaged = await mkdtemp(path.join(tmpdir(), 'pocketrisu-release-assets-'))
        tempDirs.push(packaged)
        await mkdir(path.join(packaged, 'scripts'), { recursive: true })
        await copyFile(batchTemplate, path.join(packaged, 'update.bat'))
        await copyFile(
            finalizerSource,
            path.join(packaged, 'scripts', 'recoveryPathLockFinalizer.cjs'),
        )
        await expect(readFile(path.join(packaged, 'update.bat'), 'utf8'))
            .resolves.toContain('recoveryPathLockFinalizer.cjs')
        await expect(readFile(
            path.join(packaged, 'scripts', 'recoveryPathLockFinalizer.cjs'),
            'utf8',
        )).resolves.toContain('finalizeRecoveryPathStateLockHandoffSync')
    })
})
