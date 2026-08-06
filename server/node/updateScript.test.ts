import { spawn, spawnSync } from 'node:child_process'
import {
    access,
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []
const updateScript = path.resolve(import.meta.dirname, '../../update.sh')
const recoveryPathMarkerHelper = path.resolve(import.meta.dirname, 'recoveryPathMarkers.cjs')

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeExecutable(filePath: string, contents: string): Promise<void> {
    await writeFile(filePath, `${contents}\n`)
    await chmod(filePath, 0o755)
}

async function waitForPath(filePath: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try { await access(filePath); return } catch {}
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for ${filePath}`)
}

async function createHarness(markerOverrides: Record<string, string | null> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'pocketrisu-update-test-'))
    tempDirs.push(root)

    const installDir = path.join(root, 'app')
    const releaseRoot = path.join(root, 'release-source')
    const releaseDir = path.join(releaseRoot, 'PocketRisu-v-test')
    const tarball = path.join(root, 'release.tar.gz')
    const fakeBin = path.join(root, 'bin')

    await mkdir(path.join(installDir, 'save'), { recursive: true })
    await mkdir(path.join(installDir, 'backups'), { recursive: true })
    await mkdir(path.join(installDir, 'server', 'node'), { recursive: true })
    await mkdir(releaseDir, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    await copyFile(updateScript, path.join(installDir, 'update.sh'))
    await copyFile(
        recoveryPathMarkerHelper,
        path.join(installDir, 'server', 'node', 'recoveryPathMarkers.cjs'),
    )
    await copyFile(updateScript, path.join(releaseDir, 'update.sh'))
    await chmod(path.join(installDir, 'update.sh'), 0o755)
    await chmod(path.join(releaseDir, 'update.sh'), 0o755)
    await writeFile(path.join(installDir, '.installed-version'), 'v-old\n')
    await writeFile(path.join(installDir, 'old-release.txt'), 'old release')
    await writeFile(path.join(installDir, 'save', 'database.bin'), 'live database')
    await writeFile(path.join(installDir, 'backups', 'default-recovery.bin'), 'default recovery')
    await writeFile(path.join(releaseDir, 'new-release.txt'), 'new release')
    await writeFile(path.join(releaseDir, '.release-marker'), 'complete release')
    await writeFile(path.join(releaseDir, 'package.json'), '{"version":"1.0.0"}\n')

    const markerTargets: Record<string, string | null> = {
        __backup_path: 'backups',
        __chat_backup_path: 'save/chat-backups',
        ...markerOverrides,
    }
    const resolvedMarkers: Record<string, string> = {}
    for (const [markerName, relativeTarget] of Object.entries(markerTargets)) {
        if (relativeTarget === null) continue
        const markerTarget = path.resolve(installDir, relativeTarget)
        resolvedMarkers[markerName] = markerTarget
        await writeFile(path.join(installDir, 'save', markerName), markerTarget)
    }

    const tarResult = spawnSync(
        'tar',
        ['-czf', tarball, '-C', releaseRoot, path.basename(releaseDir)],
        { encoding: 'utf8' },
    )
    expect(tarResult.status, tarResult.stderr).toBe(0)

    await writeExecutable(path.join(fakeBin, 'curl'), [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "$*" == *"api.github.com"* ]]; then',
        '    printf \'%s\\n\' \'{"tag_name":"v-test"}\'',
        '    exit 0',
        'fi',
        'destination=""',
        'while [ "$#" -gt 0 ]; do',
        '    if [ "$1" = "-o" ]; then',
        '        shift',
        '        destination="$1"',
        '    fi',
        '    shift',
        'done',
        '[ -n "$destination" ]',
        'cp "$UPDATE_TEST_TARBALL" "$destination"',
    ].join('\n'))

    await writeExecutable(path.join(fakeBin, 'pnpm'), [
        '#!/usr/bin/env bash',
        'exit 0',
    ].join('\n'))

    const environment = (extraEnv: Record<string, string> = {}) => ({
            ...process.env,
            PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
            UPDATE_TEST_TARBALL: tarball,
            ...extraEnv,
    })
    const run = (extraEnv: Record<string, string> = {}) => spawnSync('bash', [path.join(installDir, 'update.sh')], {
        encoding: 'utf8',
        input: '\n',
        env: environment(extraEnv),
    })
    const start = (extraEnv: Record<string, string> = {}) => spawn(
        'bash',
        [path.join(installDir, 'update.sh')],
        { env: environment(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] },
    )

    return { installDir, resolvedMarkers, run, start }
}

describe('update.sh recovery-directory preservation', () => {
    test('preserves custom server and chat backup roots during replacement', async () => {
        const harness = await createHarness({
            __backup_path: 'recovery [custom]/server-backups',
            __chat_backup_path: 'history/chat-backups',
        })
        const serverBackup = harness.resolvedMarkers.__backup_path
        const chatBackup = harness.resolvedMarkers.__chat_backup_path
        await mkdir(serverBackup, { recursive: true })
        await mkdir(chatBackup, { recursive: true })
        await writeFile(path.join(serverBackup, 'server-recovery.bin'), 'server recovery')
        await writeFile(path.join(chatBackup, 'chat-version.bin.gz'), 'chat recovery')

        const result = harness.run()

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        await expect(readFile(path.join(harness.installDir, 'new-release.txt'), 'utf8')).resolves.toBe('new release')
        await expect(readFile(path.join(harness.installDir, 'save', 'database.bin'), 'utf8')).resolves.toBe('live database')
        await expect(readFile(path.join(harness.installDir, 'backups', 'default-recovery.bin'), 'utf8')).resolves.toBe('default recovery')
        await expect(readFile(path.join(serverBackup, 'server-recovery.bin'), 'utf8')).resolves.toBe('server recovery')
        await expect(readFile(path.join(chatBackup, 'chat-version.bin.gz'), 'utf8')).resolves.toBe('chat recovery')
        await expect(readFile(path.join(harness.installDir, 'old-release.txt'), 'utf8')).rejects.toThrow()
    })

    test('successful destructive replacement preserves a mixed-case Windows recovery entry', async () => {
        const harness = await createHarness({
            __backup_path: 'RecoveryData/server-backups',
        })
        const serverBackup = harness.resolvedMarkers.__backup_path
        await mkdir(serverBackup, { recursive: true })
        await writeFile(path.join(serverBackup, 'server-recovery.bin'), 'server recovery')

        const result = harness.run({
            NODE_ENV: 'test',
            POCKETRISU_TEST_RECOVERY_PLATFORM: 'win32',
        })

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        await expect(readFile(path.join(serverBackup, 'server-recovery.bin'), 'utf8'))
            .resolves.toBe('server recovery')
        await expect(readFile(path.join(harness.installDir, 'old-release.txt'), 'utf8'))
            .rejects.toThrow()
    })

    test('holds interprocess exclusion across marker snapshot and destructive enumeration', async () => {
        const harness = await createHarness({
            __backup_path: 'recovery/server-backups',
        })
        const recovery = harness.resolvedMarkers.__backup_path
        const gateDir = await mkdtemp(path.join(tmpdir(), 'pocketrisu-update-sh-gate-'))
        tempDirs.push(gateDir)
        await mkdir(recovery, { recursive: true })
        await writeFile(path.join(recovery, 'server-recovery.bin'), 'server recovery')
        await writeFile(path.join(gateDir, 'stage'), 'before-destructive-enumeration')
        await writeFile(path.join(gateDir, 'hold'), 'hold')

        const child = harness.start({
            NODE_ENV: 'test',
            POCKETRISU_TEST_UPDATE_SH_GATE_DIR: gateDir,
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', chunk => { stdout += chunk.toString() })
        child.stderr?.on('data', chunk => { stderr += chunk.toString() })
        child.stdin?.end('\n')
        await waitForPath(path.join(gateDir, 'entered'))

        const contender = spawnSync(process.execPath, ['-e', [
            `const helper = require(${JSON.stringify(recoveryPathMarkerHelper)});`,
            `helper.acquireRecoveryPathStateLockSync(${JSON.stringify(path.join(harness.installDir, 'save'))}, { purpose: 'second server transition' });`,
        ].join('')], { encoding: 'utf8' })
        expect(contender.status).not.toBe(0)
        expect(contender.stderr).toContain('locked by owner pid')
        await expect(readFile(path.join(recovery, 'server-recovery.bin'), 'utf8'))
            .resolves.toBe('server recovery')

        await rm(path.join(gateDir, 'hold'))
        await writeFile(path.join(gateDir, 'release'), 'release')
        const exitCode = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', resolve)
        })
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
        await expect(readFile(path.join(recovery, 'server-recovery.bin'), 'utf8'))
            .resolves.toBe('server recovery')
    })

    test('keeps the same live lock and save tree through the former recursive restore window', async () => {
        const harness = await createHarness()
        const gateDir = await mkdtemp(path.join(tmpdir(), 'pocketrisu-update-sh-restore-gate-'))
        tempDirs.push(gateDir)
        await writeFile(path.join(gateDir, 'stage'), 'during-save-restore')
        await writeFile(path.join(gateDir, 'hold'), 'hold')

        const child = harness.start({
            NODE_ENV: 'test',
            POCKETRISU_TEST_UPDATE_SH_GATE_DIR: gateDir,
        })
        let output = ''
        child.stdout?.on('data', chunk => { output += chunk.toString() })
        child.stderr?.on('data', chunk => { output += chunk.toString() })
        child.stdin?.end('\n')
        await waitForPath(path.join(gateDir, 'entered'))

        const lockOwner = path.join(
            harness.installDir,
            'save',
            '__recovery_path_state.lock',
            'owner.json',
        )
        await expect(readFile(lockOwner, 'utf8')).resolves.toContain('update.sh standalone updater')
        await expect(readFile(path.join(harness.installDir, 'save', 'database.bin'), 'utf8'))
            .resolves.toBe('live database')
        const contender = spawnSync(process.execPath, ['-e', [
            `const helper = require(${JSON.stringify(recoveryPathMarkerHelper)});`,
            `helper.acquireRecoveryPathStateLockSync(${JSON.stringify(path.join(harness.installDir, 'save'))}, { purpose: 'restore-window contender' });`,
        ].join('')], { encoding: 'utf8' })
        expect(contender.status).not.toBe(0)
        expect(contender.stderr).toContain('locked by owner pid')

        await rm(path.join(gateDir, 'hold'))
        await writeFile(path.join(gateDir, 'release'), 'release')
        const exitCode = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', resolve)
        })
        expect(exitCode, output).toBe(0)
        await expect(readFile(path.join(harness.installDir, 'save', 'database.bin'), 'utf8'))
            .resolves.toBe('live database')
        await expect(readFile(lockOwner, 'utf8')).rejects.toThrow()
    })

    test('SIGKILL at the former save-restore window leaves live data intact and the lock fail-closed', async () => {
        const harness = await createHarness()
        const gateDir = await mkdtemp(path.join(tmpdir(), 'pocketrisu-update-sh-crash-gate-'))
        tempDirs.push(gateDir)
        const taskTmp = path.join(path.dirname(harness.installDir), 'task-tmp')
        await mkdir(taskTmp)
        await writeFile(path.join(gateDir, 'stage'), 'during-save-restore')
        await writeFile(path.join(gateDir, 'hold'), 'hold')

        const child = harness.start({
            NODE_ENV: 'test',
            TMPDIR: taskTmp,
            POCKETRISU_TEST_UPDATE_SH_GATE_DIR: gateDir,
        })
        child.stdin?.end('\n')
        await waitForPath(path.join(gateDir, 'entered'))
        child.kill('SIGKILL')
        await new Promise<void>((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', () => resolve())
        })

        await expect(readFile(path.join(harness.installDir, 'save', 'database.bin'), 'utf8'))
            .resolves.toBe('live database')
        await expect(readFile(path.join(
            harness.installDir,
            'save',
            '__recovery_path_state.lock',
            'owner.json',
        ), 'utf8')).resolves.toContain('update.sh standalone updater')
        const contender = spawnSync(process.execPath, ['-e', [
            `const helper = require(${JSON.stringify(recoveryPathMarkerHelper)});`,
            `helper.acquireRecoveryPathStateLockSync(${JSON.stringify(path.join(harness.installDir, 'save'))}, { purpose: 'post-crash contender' });`,
        ].join('')], { encoding: 'utf8' })
        expect(contender.status).not.toBe(0)
        expect(contender.stderr).toContain('never removed automatically')
    })

    test('preserves every server root in a crash-transition marker during replacement', async () => {
        const harness = await createHarness()
        const oldRecovery = path.join(harness.installDir, 'old-recovery', 'backups')
        const newRecovery = path.join(harness.installDir, 'new-recovery', 'backups')
        await mkdir(oldRecovery, { recursive: true })
        await mkdir(newRecovery, { recursive: true })
        await writeFile(path.join(oldRecovery, 'old.bin'), 'old recovery')
        await writeFile(path.join(newRecovery, 'new.bin'), 'new recovery')
        await writeFile(path.join(harness.installDir, 'save', '__backup_path'), JSON.stringify({
            version: 1,
            paths: [oldRecovery, newRecovery],
        }))

        const result = harness.run()

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        await expect(readFile(path.join(oldRecovery, 'old.bin'), 'utf8')).resolves.toBe('old recovery')
        await expect(readFile(path.join(newRecovery, 'new.bin'), 'utf8')).resolves.toBe('new recovery')
        await expect(readFile(path.join(harness.installDir, 'old-release.txt'), 'utf8')).rejects.toThrow()
    })

    test('refuses a managed-root marker before deleting the old release', async () => {
        const harness = await createHarness({
            __backup_path: 'server/backups',
        })
        await mkdir(harness.resolvedMarkers.__backup_path, { recursive: true })

        const result = harness.run()

        expect(result.status).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain('inside PocketRisu app files')
        await expect(readFile(path.join(harness.installDir, 'old-release.txt'), 'utf8')).resolves.toBe('old release')
        await expect(readFile(path.join(harness.installDir, 'save', 'database.bin'), 'utf8')).resolves.toBe('live database')
    })

    test('refuses an outside symlink alias into managed app files', async () => {
        const harness = await createHarness()
        const alias = path.join(path.dirname(harness.installDir), 'outside-server-alias')
        await symlink(path.join(harness.installDir, 'server'), alias, 'dir')
        await writeFile(path.join(harness.installDir, 'save', '__backup_path'), path.join(alias, 'backups'))

        const result = harness.run()

        expect(result.status).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain('inside PocketRisu app files')
        await expect(readFile(path.join(harness.installDir, 'old-release.txt'), 'utf8')).resolves.toBe('old release')
    })

    test('refuses a missing marker before deleting an unrecorded recovery root', async () => {
        const harness = await createHarness({ __chat_backup_path: null })
        const unrecordedRecovery = path.join(harness.installDir, 'history', 'chat-backups')
        await mkdir(unrecordedRecovery, { recursive: true })
        await writeFile(path.join(unrecordedRecovery, 'chat-version.bin.gz'), 'chat recovery')

        const result = harness.run()

        expect(result.status).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain('preservation marker is missing')
        await expect(readFile(path.join(unrecordedRecovery, 'chat-version.bin.gz'), 'utf8')).resolves.toBe('chat recovery')
        await expect(readFile(path.join(harness.installDir, 'old-release.txt'), 'utf8')).resolves.toBe('old release')
    })

    test('refuses unreadable and malformed markers before deleting the old release', async () => {
        const unreadable = await createHarness()
        const unreadableMarker = path.join(unreadable.installDir, 'save', '__backup_path')
        await rm(unreadableMarker)
        await mkdir(unreadableMarker)

        const unreadableResult = unreadable.run()
        expect(unreadableResult.status).not.toBe(0)
        expect(`${unreadableResult.stdout}\n${unreadableResult.stderr}`).toContain('not a regular file')
        await expect(readFile(path.join(unreadable.installDir, 'old-release.txt'), 'utf8')).resolves.toBe('old release')

        const malformed = await createHarness()
        await writeFile(path.join(malformed.installDir, 'save', '__backup_path'), 'relative/backups')

        const malformedResult = malformed.run()
        expect(malformedResult.status).not.toBe(0)
        expect(`${malformedResult.stdout}\n${malformedResult.stderr}`).toContain('preservation marker path is not absolute')
        await expect(readFile(path.join(malformed.installDir, 'old-release.txt'), 'utf8')).resolves.toBe('old release')
    })
})
