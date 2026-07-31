import { spawnSync } from 'node:child_process'
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []
const updateScript = path.resolve(import.meta.dirname, '../../update.sh')

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeExecutable(filePath: string, contents: string): Promise<void> {
    await writeFile(filePath, `${contents}\n`)
    await chmod(filePath, 0o755)
}

async function createHarness(markerTargets: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'pocketrisu-update-test-'))
    tempDirs.push(root)

    const installDir = path.join(root, 'app')
    const releaseRoot = path.join(root, 'release-source')
    const releaseDir = path.join(releaseRoot, 'PocketRisu-v-test')
    const tarball = path.join(root, 'release.tar.gz')
    const fakeBin = path.join(root, 'bin')

    await mkdir(path.join(installDir, 'save'), { recursive: true })
    await mkdir(path.join(installDir, 'backups'), { recursive: true })
    await mkdir(releaseDir, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    await copyFile(updateScript, path.join(installDir, 'update.sh'))
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

    const resolvedMarkers: Record<string, string> = {}
    for (const [markerName, relativeTarget] of Object.entries(markerTargets)) {
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

    const run = () => spawnSync('bash', [path.join(installDir, 'update.sh')], {
        encoding: 'utf8',
        input: '\n',
        env: {
            ...process.env,
            PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
            UPDATE_TEST_TARBALL: tarball,
        },
    })

    return { installDir, resolvedMarkers, run }
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
})
