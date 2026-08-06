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
    portableAssetNameKey,
    isPortableAssetName,
    migrateAssetRowsToFilesystem,
    verifyAssetHash,
} = pkg as {
    ASSET_TEMP_PREFIX: string
    HASH_NAME_RE: RegExp
    createAssetStore: (options: { assetDir: string; fs?: typeof fs }) => AssetStore
    portableAssetNameKey: (name: string) => string
    isPortableAssetName: (name: unknown) => boolean
    migrateAssetRowsToFilesystem: (options: {
        keys: string[]
        existingAssetNames?: string[]
        getValue: (key: string) => Buffer | null
        deleteValue: (key: string) => void
        store: AssetStore
        onProgress?: (progress: unknown) => void
        onSkipped?: (skipped: {
            key: string
            name: string
            reason: 'non-portable' | 'collision'
        }) => void
    }) => {
        migrated: number
        skippedUnsafe: number
        skippedNonPortable: number
        skippedCollision: number
    }
    verifyAssetHash: (
        key: string,
        value: Buffer,
    ) => { claimed: string | null; actual: string | null; ok: boolean }
}

interface AssetStore {
    assetDir: string
    migrationMarkerPath: string
    legacyHashIdentityMarkerPath: string
    legacyHashMarkerDir: string
    ensureAssetDir: () => void
    isSafeAssetName: (name: unknown) => boolean
    portableAssetNameKey: (name: string) => string
    isPortableAssetName: (name: unknown) => boolean
    isHashShapedAssetName: (name: unknown) => boolean
    runtimeAssetFileDisposition: (name: unknown) => {
        eligible: boolean
        reason: 'non-portable' | 'collision' | null
        existingName: string | null
    }
    assetPathFor: (name: string) => string
    legacyHashMarkerPathFor: (name: string) => string
    isLegacyHashAsset: (name: string) => boolean
    markLegacyHashAsset: (name: string) => boolean
    clearLegacyHashAsset: (name: string) => boolean
    reconcileLegacyHashAssetIdentity: (
        options?: { discover?: boolean },
    ) => { marked: number; cleared: number }
    writeAssetFile: (name: string, buffer: Buffer) => void
    writeAssetFileIfChanged: (name: string, buffer: Buffer) => boolean
    readAssetFile: (name: string) => Buffer | null
    verifyStoredAssetHash: (
        name: string,
    ) => { claimed: string | null; actual: string | null; ok: boolean } | null
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

function makeCaseInsensitiveStore(): AssetStore {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-assets-'))
    tempDirs.push(root)
    const assetDir = path.join(root, 'save', 'assets')
    const fsImpl = Object.create(fs) as typeof fs
    const displayedNames = new Map<string, string>()
    const foldPath = (filePath: fs.PathLike): fs.PathLike => {
        if (typeof filePath !== 'string') return filePath
        const relative = path.relative(assetDir, filePath)
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
            || path.isAbsolute(relative)) return filePath
        return path.join(path.dirname(filePath), path.basename(filePath).toLowerCase())
    }
    fsImpl.openSync = ((filePath: fs.PathLike, ...args: unknown[]) => (
        Reflect.apply(fs.openSync, fs, [foldPath(filePath), ...args])
    )) as typeof fs.openSync
    fsImpl.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        fs.renameSync(foldPath(oldPath), foldPath(newPath))
        if (typeof newPath === 'string' && path.dirname(newPath) === assetDir) {
            const name = path.basename(newPath)
            displayedNames.set(name.toLowerCase(), name)
        }
    }) as typeof fs.renameSync
    fsImpl.readdirSync = ((directory: fs.PathLike, ...args: unknown[]) => {
        const entries = Reflect.apply(fs.readdirSync, fs, [directory, ...args])
        if (typeof directory !== 'string' || path.resolve(directory) !== assetDir
            || !Array.isArray(entries)) return entries
        return entries.map((entry) => {
            if (typeof entry !== 'object' || entry === null || !('name' in entry)) return entry
            const displayedName = displayedNames.get(String(entry.name).toLowerCase())
            if (!displayedName || displayedName === entry.name) return entry
            return new Proxy(entry, {
                get(target, property, receiver) {
                    return property === 'name'
                        ? displayedName
                        : Reflect.get(target, property, receiver)
                },
            })
        })
    }) as typeof fs.readdirSync
    fsImpl.lstatSync = ((filePath: fs.PathLike, ...args: unknown[]) => (
        Reflect.apply(fs.lstatSync, fs, [foldPath(filePath), ...args])
    )) as typeof fs.lstatSync
    fsImpl.statSync = ((filePath: fs.PathLike, ...args: unknown[]) => (
        Reflect.apply(fs.statSync, fs, [foldPath(filePath), ...args])
    )) as typeof fs.statSync
    fsImpl.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => (
        Reflect.apply(fs.readFileSync, fs, [
            typeof filePath === 'number' ? filePath : foldPath(filePath),
            ...args,
        ])
    )) as typeof fs.readFileSync
    fsImpl.unlinkSync = ((filePath: fs.PathLike) => {
        fs.unlinkSync(foldPath(filePath))
        if (typeof filePath === 'string' && path.dirname(filePath) === assetDir) {
            displayedNames.delete(path.basename(filePath).toLowerCase())
        }
    }) as typeof fs.unlinkSync
    fsImpl.writeFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => (
        Reflect.apply(fs.writeFileSync, fs, [
            typeof filePath === 'number' ? filePath : foldPath(filePath),
            ...args,
        ])
    )) as typeof fs.writeFileSync
    return createAssetStore({ assetDir, fs: fsImpl })
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

    it('identifies names that remain distinct on every supported filesystem', () => {
        for (const name of [
            'CON',
            'con.png',
            'NUL',
            'COM7.tar.gz',
            'lpt9',
            'trailing.',
            'trailing..',
        ]) {
            expect(isPortableAssetName(name)).toBe(false)
        }
        for (const name of [
            'console.png',
            'com10.png',
            'com.png',
            'nul0.png',
            'MiXeD-Ordinary_Name.WEBP',
        ]) {
            expect(isPortableAssetName(name)).toBe(true)
        }
    })

    it('folds ASCII case and strips trailing dots for portable identity', () => {
        expect(portableAssetNameKey('Foo.PNG')).toBe('foo.png')
        expect(portableAssetNameKey('Mixed.Name...')).toBe('mixed.name')
        expect(portableAssetNameKey('already-portable')).toBe('already-portable')
    })

    it('keeps non-portable runtime names out of the filesystem', () => {
        const store = makeStore()
        for (const name of ['CON.png', 'trailing.', 'unsafe name.png']) {
            expect(store.runtimeAssetFileDisposition(name)).toEqual({
                eligible: false,
                reason: 'non-portable',
                existingName: null,
            })
        }
        expect(store.listAssetFiles()).toEqual([])
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

describe('legacy hash-shaped asset identity', () => {
    it('discovers mismatched legacy files once and persists their identity', () => {
        const store = makeStore()
        const legacyName = `${'0'.repeat(64)}.png`
        const legacyValue = Buffer.from('historical bytes')
        const validValue = Buffer.from('content-addressed bytes')
        const validName = `${createHash('sha256').update(validValue).digest('hex')}.webp`
        store.writeAssetFile(legacyName, legacyValue)
        store.writeAssetFile(validName, validValue)

        expect(store.isLegacyHashAsset(legacyName)).toBe(false)
        expect(store.reconcileLegacyHashAssetIdentity({ discover: true })).toEqual({
            marked: 1,
            cleared: 0,
        })
        expect(store.isLegacyHashAsset(legacyName)).toBe(true)
        expect(store.isLegacyHashAsset(validName)).toBe(false)
        expect(fs.readFileSync(store.legacyHashIdentityMarkerPath, 'utf-8')).not.toBe('')
        expect(store.listAssetFiles().map(entry => entry.name).sort()).toEqual([
            legacyName,
            validName,
        ].sort())

        const reopened = createAssetStore({ assetDir: store.assetDir }) as AssetStore
        expect(reopened.isLegacyHashAsset(legacyName)).toBe(true)
        expect(reopened.verifyStoredAssetHash(legacyName)).toMatchObject({ ok: false })
    })

    it('prunes stale markers without discovering later filesystem corruption', () => {
        const store = makeStore()
        const validValue = Buffer.from('canonical bytes')
        const validName = `${createHash('sha256').update(validValue).digest('hex')}.png`
        const corruptValue = Buffer.from('corrupt bytes')
        const corruptName = `${createHash('sha256').update(Buffer.from('expected')).digest('hex')}.png`
        store.writeAssetFile(validName, validValue)
        store.writeAssetFile(corruptName, corruptValue)
        store.markLegacyHashAsset(validName)

        expect(store.reconcileLegacyHashAssetIdentity()).toEqual({ marked: 0, cleared: 1 })
        expect(store.isLegacyHashAsset(validName)).toBe(false)
        expect(store.isLegacyHashAsset(corruptName)).toBe(false)
    })

    it('removes identity markers with asset deletion and bulk clearing', () => {
        const store = makeStore()
        const first = `${'1'.repeat(64)}.png`
        const second = `${'2'.repeat(64)}.png`
        store.writeAssetFile(first, Buffer.from('first'))
        store.writeAssetFile(second, Buffer.from('second'))
        store.markLegacyHashAsset(first)
        store.markLegacyHashAsset(second)

        expect(store.deleteAssetFile(first)).toBe(true)
        expect(store.isLegacyHashAsset(first)).toBe(false)
        expect(store.clearAssetFiles()).toBe(1)
        expect(fs.existsSync(store.legacyHashMarkerDir)).toBe(false)
    })
})

describe('asset file operations', () => {
    it('requires exact entry identity and rejects a case-folded runtime collision', () => {
        const store = makeCaseInsensitiveStore()
        const original = Buffer.from('original bytes')
        store.writeAssetFile('Foo.png', original)

        expect(store.runtimeAssetFileDisposition('Foo.png')).toEqual({
            eligible: true,
            reason: null,
            existingName: 'Foo.png',
        })
        expect(store.runtimeAssetFileDisposition('foo.png')).toEqual({
            eligible: false,
            reason: 'collision',
            existingName: 'Foo.png',
        })
        expect(store.readAssetFile('Foo.png')).toEqual(original)
        expect(store.readAssetFile('foo.png')).toBeNull()
        expect(store.assetFileExists('foo.png')).toBe(false)
        expect(store.assetFileSize('foo.png')).toBeNull()
        expect(store.assetFileMtimeMs('foo.png')).toBeNull()
        expect(store.deleteAssetFile('foo.png')).toBe(false)
        expect(store.readAssetFile('Foo.png')).toEqual(original)
    })

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

    it('skips a byte-identical write and preserves the existing hardlink', () => {
        const store = makeStore()
        const value = Buffer.from('same bytes')
        store.writeAssetFile('hashed.png', value)
        const linkedCopy = path.join(path.dirname(store.assetDir), 'linked-hash.png')
        fs.linkSync(store.assetPathFor('hashed.png'), linkedCopy)
        const before = fs.statSync(store.assetPathFor('hashed.png'))

        expect(store.writeAssetFileIfChanged('hashed.png', value)).toBe(false)
        const afterSkip = fs.statSync(store.assetPathFor('hashed.png'))
        expect(afterSkip.ino).toBe(before.ino)
        expect(fs.statSync(linkedCopy).ino).toBe(before.ino)

        expect(store.writeAssetFileIfChanged('hashed.png', Buffer.from('different length'))).toBe(true)
        expect(fs.statSync(store.assetPathFor('hashed.png')).ino).not.toBe(before.ino)
        expect(fs.readFileSync(linkedCopy)).toEqual(value)
    })

    it('repairs a same-length hash-named destination whose bytes differ', () => {
        const store = makeStore()
        const good = Buffer.from('good bytes')
        const corrupt = Buffer.from('BAD! bytes')
        const name = `${createHash('sha256').update(good).digest('hex')}.png`
        store.writeAssetFile(name, corrupt)

        expect(store.writeAssetFileIfChanged(name, good)).toBe(true)
        expect(store.readAssetFile(name)).toEqual(good)
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
    it('moves safe rows, leaves unsafe rows, and skips byte-identical rewrites', () => {
        const store = makeStore()
        store.writeAssetFile('identical.bin', Buffer.from('same'))
        store.writeAssetFile('stale.bin', Buffer.from('disk'))
        const beforeMtime = store.assetFileMtimeMs('identical.bin')
        const rows = new Map<string, Buffer>([
            ['assets/new.png', Buffer.from('new value')],
            ['assets/identical.bin', Buffer.from('same')],
            ['assets/stale.bin', Buffer.from('true')],
            ['assets/unsafe name.png', Buffer.from('legacy')],
        ])
        const deleted: string[] = []

        const result = migrateAssetRowsToFilesystem({
            keys: [...rows.keys()],
            existingAssetNames: store.listAssetFiles().map(entry => entry.name),
            getValue: (key) => rows.get(key) ?? null,
            deleteValue: (key) => {
                deleted.push(key)
                rows.delete(key)
            },
            store,
        })

        expect(result).toEqual({
            migrated: 3,
            skippedUnsafe: 1,
            skippedNonPortable: 0,
            skippedCollision: 0,
        })
        expect(store.readAssetFile('new.png')).toEqual(Buffer.from('new value'))
        expect(store.readAssetFile('identical.bin')).toEqual(Buffer.from('same'))
        expect(store.assetFileMtimeMs('identical.bin')).toBe(beforeMtime)
        // Same length as the stale disk bytes: the row must still win.
        expect(store.readAssetFile('stale.bin')).toEqual(Buffer.from('true'))
        expect(deleted).toEqual(['assets/new.png', 'assets/identical.bin', 'assets/stale.bin'])
        expect(rows.has('assets/unsafe name.png')).toBe(true)
    })

    it('preflights case collisions and non-portable names before writing rows', () => {
        const store = makeStore()
        const existingValue = Buffer.from('existing disk value')
        store.writeAssetFile('Existing.png', existingValue)
        store.writeAssetFile('exact.bin', Buffer.from('same bytes'))
        const rows = new Map<string, Buffer>([
            ['assets/Foo.png', Buffer.from('upper value')],
            ['assets/foo.png', Buffer.from('lower value')],
            ['assets/existing.png', Buffer.from('must not overwrite disk')],
            ['assets/exact.bin', Buffer.from('same bytes')],
            ['assets/CON.png', Buffer.from('reserved')],
            ['assets/trailing.', Buffer.from('one trailing dot')],
            ['assets/trailing..', Buffer.from('two trailing dots')],
            ['assets/unsafe name.png', Buffer.from('unsafe')],
            ['assets/unique.png', Buffer.from('unique')],
        ])
        const skipped: Array<{ key: string; reason: string }> = []

        const result = migrateAssetRowsToFilesystem({
            keys: [...rows.keys()],
            existingAssetNames: store.listAssetFiles().map(entry => entry.name),
            getValue: (key) => rows.get(key) ?? null,
            deleteValue: (key) => rows.delete(key),
            store,
            onSkipped: ({ key, reason }) => skipped.push({ key, reason }),
        })

        expect(result).toEqual({
            migrated: 2,
            skippedUnsafe: 1,
            skippedNonPortable: 3,
            skippedCollision: 3,
        })
        expect(store.readAssetFile('Foo.png')).toBeNull()
        expect(store.readAssetFile('foo.png')).toBeNull()
        expect(store.readAssetFile('Existing.png')).toEqual(existingValue)
        expect(store.readAssetFile('existing.png')).toBeNull()
        expect(store.readAssetFile('exact.bin')).toEqual(Buffer.from('same bytes'))
        expect(store.readAssetFile('unique.png')).toEqual(Buffer.from('unique'))
        expect([...rows.keys()].sort()).toEqual([
            'assets/CON.png',
            'assets/Foo.png',
            'assets/existing.png',
            'assets/foo.png',
            'assets/trailing.',
            'assets/trailing..',
            'assets/unsafe name.png',
        ].sort())
        expect(skipped).toHaveLength(6)
        expect(skipped.filter(entry => entry.reason === 'collision')).toHaveLength(3)
        expect(skipped.filter(entry => entry.reason === 'non-portable')).toHaveLength(3)
    })

    it('preflights collisions before touching a case-insensitive filesystem', () => {
        const store = makeCaseInsensitiveStore()
        const rows = new Map<string, Buffer>([
            ['assets/Foo.png', Buffer.from('A')],
            ['assets/foo.png', Buffer.from('B')],
        ])

        const collisionResult = migrateAssetRowsToFilesystem({
            keys: [...rows.keys()],
            existingAssetNames: store.listAssetFiles().map(entry => entry.name),
            getValue: (key) => rows.get(key) ?? null,
            deleteValue: (key) => rows.delete(key),
            store,
        })

        expect(collisionResult).toEqual({
            migrated: 0,
            skippedUnsafe: 0,
            skippedNonPortable: 0,
            skippedCollision: 2,
        })
        expect(rows.get('assets/Foo.png')).toEqual(Buffer.from('A'))
        expect(rows.get('assets/foo.png')).toEqual(Buffer.from('B'))
        expect(store.listAssetFiles()).toEqual([])

        const mixedRows = new Map([['assets/MiXeD.png', Buffer.from('mixed value')]])
        const mixedResult = migrateAssetRowsToFilesystem({
            keys: [...mixedRows.keys()],
            existingAssetNames: store.listAssetFiles().map(entry => entry.name),
            getValue: (key) => mixedRows.get(key) ?? null,
            deleteValue: (key) => mixedRows.delete(key),
            store,
        })

        expect(mixedResult).toEqual({
            migrated: 1,
            skippedUnsafe: 0,
            skippedNonPortable: 0,
            skippedCollision: 0,
        })
        expect(mixedRows.size).toBe(0)
        expect(fs.readdirSync(store.assetDir)).toContain('mixed.png')
        expect(store.readAssetFile('MiXeD.png')).toEqual(Buffer.from('mixed value'))
    })
})
