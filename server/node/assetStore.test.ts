import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import pkg from './assetStore.cjs'

const {
    ASSET_TEMP_PREFIX,
    HASH_NAME_RE,
    createAssetStore,
    migrateAssetRowsToFilesystem,
    verifyAssetHash,
} = pkg as {
    ASSET_TEMP_PREFIX: string
    HASH_NAME_RE: RegExp
    createAssetStore: (options: { assetDir: string; fs?: typeof fs }) => AssetStore
    migrateAssetRowsToFilesystem: (options: {
        keys: string[]
        getValue: (key: string) => Buffer | null
        deleteValue: (key: string) => void
        store: AssetStore
        onProgress?: (progress: unknown) => void
    }) => { migrated: number; skippedUnsafe: number }
    verifyAssetHash: (
        key: string,
        value: Buffer,
    ) => { claimed: string | null; actual: string | null; ok: boolean }
}

interface AssetStore {
    assetDir: string
    migrationMarkerPath: string
    ensureAssetDir: () => void
    isSafeAssetName: (name: unknown) => boolean
    assetPathFor: (name: string) => string
    writeAssetFile: (name: string, buffer: Buffer) => void
    writeAssetFileIfSizeDiffers: (name: string, buffer: Buffer) => boolean
    readAssetFile: (name: string) => Buffer | null
    assetFileExists: (name: string) => boolean
    assetFileSize: (name: string) => number | null
    assetFileMtimeMs: (name: string) => number | null
    deleteAssetFile: (name: string) => boolean
    listAssetFiles: () => Array<{ name: string; size: number; mtimeMs: number }>
    sumAssetFsBytes: () => number
    clearAssetFiles: () => number
    swapAssetDirectoryFromStaging: (
        stagingDir: string,
        backupDir: string,
    ) => { rollback: () => void; finalize: () => void }
}

const tempDirs: string[] = []

function makeStore(fsImpl: typeof fs = fs): AssetStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-assets-'))
    tempDirs.push(root)
    return createAssetStore({ assetDir: path.join(root, 'save', 'assets'), fs: fsImpl })
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

describe('asset filename safety', () => {
    it('accepts only bounded, plain filenames', () => {
        const store = makeStore()
        expect(store.isSafeAssetName('a')).toBe(true)
        expect(store.isSafeAssetName('A0_-x.y')).toBe(true)
        expect(store.isSafeAssetName('a'.repeat(200))).toBe(true)
        expect(store.isSafeAssetName('a..b')).toBe(true)

        for (const name of [
            '',
            '.hidden',
            '.migrated_to_fs',
            `${ASSET_TEMP_PREFIX}work`,
            'has space.png',
            '한글.png',
            'a/b.png',
            'a\\b.png',
            '..',
            'a'.repeat(201),
        ]) {
            expect(store.isSafeAssetName(name)).toBe(false)
        }
        expect(store.isSafeAssetName(null)).toBe(false)
        expect(store.isSafeAssetName(123)).toBe(false)
    })

    it('rejects unsafe paths before joining them to the asset directory', () => {
        const store = makeStore()
        expect(store.assetPathFor('safe.png')).toBe(path.join(store.assetDir, 'safe.png'))
        expect(() => store.assetPathFor('../escape')).toThrow('Invalid asset name')
    })
})

describe('asset hash verification', () => {
    it('accepts content matching a hash-named key', () => {
        const value = Buffer.from('verified asset')
        const hash = createHash('sha256').update(value).digest('hex')
        const key = `assets/${hash}.png`

        expect(HASH_NAME_RE.test(key)).toBe(true)
        expect(verifyAssetHash(key, value)).toEqual({
            claimed: hash,
            actual: hash,
            ok: true,
        })
    })

    it('reports the claimed and actual hashes on mismatch', () => {
        const claimed = '0'.repeat(64)
        const value = Buffer.from('different bytes')
        const actual = createHash('sha256').update(value).digest('hex')

        expect(verifyAssetHash(`assets/${claimed}.webp`, value)).toEqual({
            claimed,
            actual,
            ok: false,
        })
    })

    it('exempts legacy, unsafe, uppercase-hash, and long-extension names', () => {
        for (const key of [
            'assets/legacy-id.png',
            `assets/${'a'.repeat(64)}.extension11`,
            `assets/${'A'.repeat(64)}.png`,
            `other/${'a'.repeat(64)}.png`,
            'assets/unsafe name.png',
        ]) {
            expect(verifyAssetHash(key, Buffer.from('anything'))).toEqual({
                claimed: null,
                actual: null,
                ok: true,
            })
        }
    })
})

describe('asset file operations', () => {
    it('round-trips write, read, list, metadata, and delete', () => {
        const store = makeStore()
        const value = Buffer.from('asset bytes')

        store.writeAssetFile('abc.png', value)
        expect(store.assetFileExists('abc.png')).toBe(true)
        expect(store.readAssetFile('abc.png')).toEqual(value)
        expect(store.assetFileSize('abc.png')).toBe(value.length)
        expect(store.assetFileMtimeMs('abc.png')).toBeTypeOf('number')
        expect(store.listAssetFiles()).toEqual([
            expect.objectContaining({ name: 'abc.png', size: value.length }),
        ])

        expect(store.deleteAssetFile('abc.png')).toBe(true)
        expect(store.deleteAssetFile('abc.png')).toBe(false)
        expect(store.readAssetFile('abc.png')).toBeNull()
        expect(store.assetFileSize('abc.png')).toBeNull()
        expect(store.assetFileMtimeMs('abc.png')).toBeNull()
    })

    it('publishes only a complete temp file and detaches an existing hardlink', () => {
        const observed: Array<{ final: Buffer; temp: Buffer }> = []
        const fsImpl = Object.create(fs) as typeof fs
        const store = makeStore(fsImpl)
        store.writeAssetFile('shared.bin', Buffer.from('old'))

        fsImpl.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
            observed.push({
                final: fs.readFileSync(to),
                temp: fs.readFileSync(from),
            })
            fs.renameSync(from, to)
        }) as typeof fs.renameSync

        const linkedCopy = path.join(path.dirname(store.assetDir), 'linked-copy.bin')
        fs.linkSync(store.assetPathFor('shared.bin'), linkedCopy)

        observed.length = 0
        store.writeAssetFile('shared.bin', Buffer.from('complete replacement'))

        expect(observed).toEqual([{
            final: Buffer.from('old'),
            temp: Buffer.from('complete replacement'),
        }])
        expect(store.readAssetFile('shared.bin')).toEqual(Buffer.from('complete replacement'))
        expect(fs.readFileSync(linkedCopy)).toEqual(Buffer.from('old'))
        expect(fs.readdirSync(store.assetDir).some((name) => name.startsWith(ASSET_TEMP_PREFIX))).toBe(false)
    })

    it('excludes dotfiles, temp files, directories, and symlinks from listings', () => {
        const store = makeStore()
        store.ensureAssetDir()
        store.writeAssetFile('visible.bin', Buffer.alloc(3))
        fs.writeFileSync(path.join(store.assetDir, '.hidden'), Buffer.alloc(4))
        fs.writeFileSync(path.join(store.assetDir, `${ASSET_TEMP_PREFIX}leftover`), Buffer.alloc(5))
        fs.mkdirSync(path.join(store.assetDir, 'directory'))
        fs.symlinkSync(store.assetPathFor('visible.bin'), path.join(store.assetDir, 'linked.bin'))

        expect(store.listAssetFiles().map((entry) => entry.name)).toEqual(['visible.bin'])
        expect(store.sumAssetFsBytes()).toBe(3)
    })

    it('reports exact aggregate size and file mtime', () => {
        const store = makeStore()
        store.writeAssetFile('one.bin', Buffer.alloc(7))
        store.writeAssetFile('two.bin', Buffer.alloc(11))
        const mtime = new Date('2025-01-02T03:04:05.000Z')
        fs.utimesSync(store.assetPathFor('one.bin'), mtime, mtime)

        expect(store.sumAssetFsBytes()).toBe(18)
        expect(store.assetFileMtimeMs('one.bin')).toBe(mtime.getTime())
    })

    it('skips a same-size write and preserves the existing hardlink', () => {
        const store = makeStore()
        const value = Buffer.from('same bytes')
        store.writeAssetFile('hashed.png', value)
        const linkedCopy = path.join(path.dirname(store.assetDir), 'linked-hash.png')
        fs.linkSync(store.assetPathFor('hashed.png'), linkedCopy)
        const before = fs.statSync(store.assetPathFor('hashed.png'))

        expect(store.writeAssetFileIfSizeDiffers('hashed.png', value)).toBe(false)
        const afterSkip = fs.statSync(store.assetPathFor('hashed.png'))
        expect(afterSkip.ino).toBe(before.ino)
        expect(fs.statSync(linkedCopy).ino).toBe(before.ino)

        expect(store.writeAssetFileIfSizeDiffers('hashed.png', Buffer.from('different length'))).toBe(true)
        expect(fs.statSync(store.assetPathFor('hashed.png')).ino).not.toBe(before.ino)
        expect(fs.readFileSync(linkedCopy)).toEqual(value)
    })

    it('clears asset and temp files while preserving the migration marker', () => {
        const store = makeStore()
        store.writeAssetFile('one.bin', Buffer.alloc(1))
        store.writeAssetFile('two.bin', Buffer.alloc(2))
        fs.writeFileSync(path.join(store.assetDir, `${ASSET_TEMP_PREFIX}leftover`), Buffer.alloc(3))
        fs.writeFileSync(store.migrationMarkerPath, 'done')

        expect(store.clearAssetFiles()).toBe(3)
        expect(store.listAssetFiles()).toEqual([])
        expect(fs.readFileSync(store.migrationMarkerPath, 'utf-8')).toBe('done')
    })
})

describe('asset directory staging', () => {
    it('restores the previous asset directory when activation fails mid-swap', () => {
        const fsImpl = Object.create(fs) as typeof fs
        const store = makeStore(fsImpl)
        store.writeAssetFile('old.bin', Buffer.from('old asset'))

        const stagingDir = path.join(path.dirname(store.assetDir), 'assets_import_staging')
        const backupDir = path.join(path.dirname(store.assetDir), 'assets_import_backup')
        const stagingStore = createAssetStore({ assetDir: stagingDir })
        stagingStore.writeAssetFile('new.bin', Buffer.from('new asset'))

        let renames = 0
        fsImpl.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
            renames++
            if (renames === 2) throw new Error('simulated staging activation failure')
            fs.renameSync(from, to)
        }) as typeof fs.renameSync

        expect(() => store.swapAssetDirectoryFromStaging(stagingDir, backupDir))
            .toThrow('simulated staging activation failure')
        expect(store.readAssetFile('old.bin')).toEqual(Buffer.from('old asset'))
        expect(store.readAssetFile('new.bin')).toBeNull()
        expect(fs.existsSync(backupDir)).toBe(false)
        expect(fs.existsSync(stagingDir)).toBe(false)
    })

    it('can roll back an activated staging directory before finalization', () => {
        const store = makeStore()
        store.writeAssetFile('old.bin', Buffer.from('old asset'))
        const stagingDir = path.join(path.dirname(store.assetDir), 'assets_import_staging')
        const backupDir = path.join(path.dirname(store.assetDir), 'assets_import_backup')
        const stagingStore = createAssetStore({ assetDir: stagingDir })
        stagingStore.writeAssetFile('new.bin', Buffer.from('new asset'))

        const swap = store.swapAssetDirectoryFromStaging(stagingDir, backupDir)
        expect(store.readAssetFile('new.bin')).toEqual(Buffer.from('new asset'))
        swap.rollback()

        expect(store.readAssetFile('old.bin')).toEqual(Buffer.from('old asset'))
        expect(store.readAssetFile('new.bin')).toBeNull()
        expect(fs.existsSync(backupDir)).toBe(false)
    })
})

describe('asset row migration core', () => {
    it('moves safe rows, leaves unsafe rows, and skips same-size rewrites', () => {
        const store = makeStore()
        store.writeAssetFile('existing.bin', Buffer.from('disk'))
        const beforeMtime = store.assetFileMtimeMs('existing.bin')
        const rows = new Map<string, Buffer>([
            ['assets/new.png', Buffer.from('new value')],
            ['assets/existing.bin', Buffer.from('same')],
            ['assets/unsafe name.png', Buffer.from('legacy')],
        ])
        const deleted: string[] = []

        const result = migrateAssetRowsToFilesystem({
            keys: [...rows.keys()],
            getValue: (key) => rows.get(key) ?? null,
            deleteValue: (key) => {
                deleted.push(key)
                rows.delete(key)
            },
            store,
        })

        expect(result).toEqual({ migrated: 2, skippedUnsafe: 1 })
        expect(store.readAssetFile('new.png')).toEqual(Buffer.from('new value'))
        expect(store.readAssetFile('existing.bin')).toEqual(Buffer.from('disk'))
        expect(store.assetFileMtimeMs('existing.bin')).toBe(beforeMtime)
        expect(deleted).toEqual(['assets/new.png', 'assets/existing.bin'])
        expect(rows.has('assets/unsafe name.png')).toBe(true)
    })
})
