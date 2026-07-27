import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const tempDirs: string[] = []
const installScript = path.resolve(import.meta.dirname, '../../install.sh')

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeExecutable(filePath: string, contents: string): Promise<void> {
    await writeFile(filePath, `${contents}\n`)
    await chmod(filePath, 0o755)
}

async function createHarness(failStageMove: boolean, existingInstall = true) {
    const root = await mkdtemp(path.join(tmpdir(), 'pocketrisu-install-test-'))
    tempDirs.push(root)

    const installDir = path.join(root, 'app')
    const releaseRoot = path.join(root, 'release-source')
    const releaseDir = path.join(releaseRoot, 'PocketRisu-v-test')
    const tarball = path.join(root, 'release.tar.gz')
    const fakeBin = path.join(root, 'bin')

    await mkdir(releaseDir, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    await writeFile(path.join(releaseDir, 'new-release.txt'), 'new release')

    if (existingInstall) {
        await mkdir(path.join(installDir, 'save'), { recursive: true })
        await mkdir(path.join(installDir, 'backups'), { recursive: true })
        await writeFile(path.join(installDir, 'old-release.txt'), 'old release')
        await writeFile(path.join(installDir, 'save', 'database.bin'), 'live database')
        await writeFile(path.join(installDir, 'backups', 'recovery.bin'), 'recovery copy')
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
        'cp "$INSTALL_TEST_TARBALL" "$destination"',
    ].join('\n'))

    await writeExecutable(path.join(fakeBin, 'pnpm'), [
        '#!/usr/bin/env bash',
        'exit 0',
    ].join('\n'))

    await writeExecutable(path.join(fakeBin, 'mv'), [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [ "${INSTALL_TEST_FAIL_STAGE_MOVE:-0}" = "1" ] && [ "$#" -eq 2 ] && [ "$2" = "$RISU_INSTALL_DIR" ]; then',
        '    case "$(basename "$1")" in',
        '        .*install.*) exit 73 ;;',
        '    esac',
        'fi',
        'exec /bin/mv "$@"',
    ].join('\n'))

    const result = spawnSync('bash', [installScript], {
        encoding: 'utf8',
        input: 'y\n',
        env: {
            ...process.env,
            PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
            RISU_INSTALL_DIR: installDir,
            INSTALL_TEST_TARBALL: tarball,
            INSTALL_TEST_FAIL_STAGE_MOVE: failStageMove ? '1' : '0',
        },
    })

    return { installDir, result, root }
}

describe('install.sh staged installation', () => {
    test('publishes a completely staged fresh installation', async () => {
        const { installDir, result, root } = await createHarness(false, false)

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        await expect(readFile(path.join(installDir, 'new-release.txt'), 'utf8')).resolves.toBe('new release')
        await expect(readFile(path.join(installDir, '.installed-version'), 'utf8')).resolves.toBe('v-test\n')
        expect((await readdir(root)).some((name) => name.startsWith('.app.install.'))).toBe(false)
    })

    test('preserves save and backups after a successful staged replacement', async () => {
        const { installDir, result, root } = await createHarness(false)

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
        await expect(readFile(path.join(installDir, 'new-release.txt'), 'utf8')).resolves.toBe('new release')
        await expect(readFile(path.join(installDir, 'save', 'database.bin'), 'utf8')).resolves.toBe('live database')
        await expect(readFile(path.join(installDir, 'backups', 'recovery.bin'), 'utf8')).resolves.toBe('recovery copy')
        await expect(readFile(path.join(installDir, '.installed-version'), 'utf8')).resolves.toBe('v-test\n')
        await expect(readFile(path.join(installDir, 'old-release.txt'), 'utf8')).rejects.toThrow()
        expect((await readdir(root)).some((name) => name.startsWith('.app.old.'))).toBe(false)
    })

    test('restores the original installation when replacement fails before data transfer', async () => {
        const { installDir, result, root } = await createHarness(true)

        expect(result.status).not.toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).toContain('The existing installation was restored.')
        await expect(readFile(path.join(installDir, 'old-release.txt'), 'utf8')).resolves.toBe('old release')
        await expect(readFile(path.join(installDir, 'save', 'database.bin'), 'utf8')).resolves.toBe('live database')
        await expect(readFile(path.join(installDir, 'backups', 'recovery.bin'), 'utf8')).resolves.toBe('recovery copy')
        await expect(readFile(path.join(installDir, 'new-release.txt'), 'utf8')).rejects.toThrow()
        expect((await readdir(root)).some((name) => name.startsWith('.app.old.'))).toBe(false)
        expect((await readdir(root)).some((name) => name.startsWith('.app.install.'))).toBe(false)
    })
})
