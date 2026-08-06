import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import chatBackupsPkg from './chatBackups.cjs'
import utilsPkg from './utils.cjs'

interface BackupVersion {
    versionId: string
    ts: number
    reason: string
    size: number
    storage: 'loose' | 'bundle'
    bundleFile?: string
}

interface ChatBackupStore {
    captureChatPreImage: (input: {
        chaId: string
        chatId: string
        reason?: string
        force?: boolean
        required?: boolean
    }) => Promise<string>
    normalizeChatBackups: () => Promise<{
        rootsVisited: number
        looseVersionsConverted: number
        framesCreated: number
        conflictsPreserved: number
        legacyBundlesMigrated: number
        framesVerified: number
        framesInvalid: number
    }>
    reconcileChatBackups: () => Promise<{
        staleTempsRemoved: number
        gzipped: number
        framesCreated: number
        bundlesCreated: number
        bundlesRotated: number
        legacyBundlesMigrated: number
        versionsTrimmed: number
        uncompressedVersionsTrimmed: number
        totalUncompressedBytes: number
        maxUncompressedBytes: number
        budgetItemsRemoved: number
        totalBytes: number
        maxBytes: number
    }>
    listChatBackupChats: () => Array<{
        chaId: string
        chatId: string
        versionCount: number
        newestTs: number
        oldestTs: number
        totalBytes: number
    }>
    listChatBackups: (chaId: string, chatId: string) => BackupVersion[]
    readChatBackup: (
        chaId: string,
        chatId: string,
        versionId: string,
    ) => Promise<Buffer | null>
    scanChatBackupVersions: (
        visitor: (raw: Buffer, identity: {
            chaId: string
            chatId: string
            versionId: string
            sourceVersionId: string
            storage: 'loose' | 'loose-gzip' | 'frame' | 'legacy-bundle'
            rootIdentity: string
        }) => Promise<void> | void,
    ) => Promise<{ totalVersions: number }>
    close: () => void
}

const {
    createChatBackupStore,
    migrateLegacyChatBackups,
    resolveChatBackupDir,
    resolveChatBackupMaxBytes,
    resolveChatBackupMaxUncompressedBytes,
    sanitizeBackupReason,
    isDestructiveBackupReason,
    CHAT_BACKUP_MAX_BYTES_KEY,
    CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_KEY,
    FRAME_FORMAT,
    COLD_STORAGE_HEADER,
} = chatBackupsPkg as {
    createChatBackupStore: (options: any) => ChatBackupStore
    migrateLegacyChatBackups: (options: any) => {
        copied: number
        deduplicated: number
        conflicts: number
        failed: number
    }
    resolveChatBackupDir: (options?: any) => string
    resolveChatBackupMaxBytes: (options?: any) => number
    resolveChatBackupMaxUncompressedBytes: (options?: any) => number
    sanitizeBackupReason: (reason?: unknown) => string
    isDestructiveBackupReason: (reason?: unknown) => boolean
    CHAT_BACKUP_MAX_BYTES_KEY: string
    CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_KEY: string
    FRAME_FORMAT: string
    COLD_STORAGE_HEADER: string
}
const { decodeRisuSave, encodeRisuSaveLegacy } = utilsPkg as {
    decodeRisuSave: (value: Buffer | Uint8Array) => Promise<any>
    encodeRisuSaveLegacy: (value: any) => Uint8Array
}

const tempRoots: string[] = []
const stores: ChatBackupStore[] = []

afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

function rowKey(chaId: string, chatId: string) {
    return `${chaId}\u0000${chatId}`
}

function rawChat(index: number, extra = '') {
    return Buffer.from(encodeRisuSaveLegacy({
        id: `chat-${index}`,
        name: `Version ${index}`,
        message: [{ role: 'user', data: `message-${index}-${extra}` }],
    }))
}

function chatDir(root: string, chaId: string, chatId: string) {
    return path.join(
        root,
        'chat-backups',
        encodeURIComponent(chaId),
        encodeURIComponent(chatId),
    )
}

function recursiveSnapshot(directory: string, base = directory): Array<{
    name: string
    data: string
}> {
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const fullPath = path.join(directory, entry.name)
            if (entry.isDirectory()) return recursiveSnapshot(fullPath, base)
            return [{
                name: path.relative(base, fullPath),
                data: fs.readFileSync(fullPath).toString('base64'),
            }]
        })
        .sort((a, b) => a.name.localeCompare(b.name))
}

function writeLegacySolidBundle(directory: string, fixtures: Array<{
    versionId: string
    raw: Buffer
}>) {
    let offset = 0
    const entries = fixtures.map(({ versionId, raw }) => {
        const match = /^v-(\d+)-(\d+)-([a-z0-9_-]+)$/.exec(versionId)
        if (!match) throw new Error(`invalid test version ID: ${versionId}`)
        const entry = {
            versionId,
            ts: Number(match[1]),
            reason: match[3],
            offset,
            size: raw.length,
        }
        offset += raw.length
        return entry
    })
    const bundle = zlib.gzipSync(Buffer.concat(fixtures.map(({ raw }) => raw)))
    const bundleFile = `archive-${entries[0].ts}-${entries.at(-1)?.ts}.bundle`
    const bundlePath = path.join(directory, bundleFile)
    fs.writeFileSync(bundlePath, bundle)
    fs.writeFileSync(bundlePath.replace(/\.bundle$/, '.meta.json'), `${JSON.stringify({
        format: 'pocketrisu-chat-backup-bundle-v1',
        entryCount: entries.length,
        compressedSize: bundle.length,
        entries,
    })}\n`)
    return { bundleFile, bundlePath }
}

function readFrameFixture(filename: string) {
    const bytes = fs.readFileSync(filename)
    expect(bytes.subarray(0, 8).toString('ascii')).toBe('PRCHATF1')
    const headerBytes = bytes.readUInt32LE(8)
    const compressedBytes = Number(bytes.readBigUInt64LE(12))
    const payloadOffset = 20 + headerBytes
    expect(payloadOffset + compressedBytes).toBe(bytes.length)
    return {
        header: JSON.parse(bytes.subarray(20, payloadOffset).toString('utf-8')),
        payload: bytes.subarray(payloadOffset),
    }
}

function writeFrameFixture(directory: string, versionId: string, raw: Buffer) {
    const match = /^v-(\d+)-(\d+)-([a-z0-9_-]+)$/.exec(versionId)
    if (!match) throw new Error(`invalid test version ID: ${versionId}`)
    const payload = zlib.gzipSync(raw)
    const header = Buffer.from(JSON.stringify({
        format: FRAME_FORMAT,
        contentType: 'application/vnd.pocketrisu.chat-row',
        compression: 'gzip',
        uncompressedSize: raw.length,
        sha256: crypto.createHash('sha256').update(raw).digest('hex'),
        versionId,
        timestamp: Number(match[1]),
        sequence: Number(match[2]),
        reason: match[3],
    }), 'utf8')
    const prefix = Buffer.alloc(20)
    prefix.write('PRCHATF1', 0, 'ascii')
    prefix.writeUInt32LE(header.length, 8)
    prefix.writeBigUInt64LE(BigInt(payload.length), 12)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, `${versionId}.frame`), Buffer.concat([
        prefix,
        header,
        payload,
    ]))
}

function makeHarness(options: {
    now?: number
    cooldownMs?: number
    versionsPerBundle?: number
    maxBundlesPerChat?: number
    maxVersionsPerChat?: number
    decodeChat?: (raw: Buffer) => Promise<any>
    maxBytes?: number
    maxUncompressedBytes?: number
    diagnostics?: { onEvent: (event: Record<string, any>) => void }
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chat-backups-'))
    tempRoots.push(root)
    const rows = new Map<string, Buffer>()
    let clock = options.now ?? 1_000_000
    let maxBytes = options.maxBytes ?? 100 * 1024 * 1024
    let maxUncompressedBytes = options.maxUncompressedBytes ?? 100 * 1024 * 1024
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }
    const store = createChatBackupStore({
        getChatBackupsRoot: () => path.join(root, 'chat-backups'),
        readChatRowRaw: (chaId: string, chatId: string) => (
            rows.get(rowKey(chaId, chatId)) ?? null
        ),
        logger,
        now: () => clock,
        cooldownMs: options.cooldownMs ?? 0,
        versionsPerBundle: options.versionsPerBundle ?? 25,
        maxBundlesPerChat: options.maxBundlesPerChat ?? 4,
        maxVersionsPerChat: options.maxVersionsPerChat,
        getByteBudget: () => maxBytes,
        getUncompressedByteBudget: () => maxUncompressedBytes,
        byteBudgetMin: 1,
        uncompressedByteBudgetMin: 1,
        autoReconcile: false,
        diagnostics: options.diagnostics,
        decodeChat: options.decodeChat ?? decodeRisuSave,
    })
    stores.push(store)

    return {
        root,
        rows,
        store,
        logger,
        setRow(chaId: string, chatId: string, raw: Buffer) {
            rows.set(rowKey(chaId, chatId), Buffer.from(raw))
        },
        setNow(value: number) {
            clock = value
        },
        advance(ms = 1) {
            clock += ms
        },
        setMaxBytes(value: number) {
            maxBytes = value
        },
        setMaxUncompressedBytes(value: number) {
            maxUncompressedBytes = value
        },
    }
}

describe('chat backup root and legacy migration', () => {
    it('resolves the default inside save and accepts absolute or cwd-relative overrides', () => {
        const cwd = path.join(os.tmpdir(), 'pocketrisu-root-resolution')
        const savePath = path.join(cwd, 'save')

        expect(resolveChatBackupDir({ cwd, savePath, env: {} }))
            .toBe(path.join(savePath, 'chat-backups'))
        expect(resolveChatBackupDir({
            cwd,
            savePath,
            env: { POCKETRISU_CHAT_BACKUP_DIR: 'persistent/chat-history' },
        })).toBe(path.join(cwd, 'persistent', 'chat-history'))
        expect(resolveChatBackupDir({
            cwd,
            savePath,
            env: { POCKETRISU_CHAT_BACKUP_DIR: '/mnt/pocketrisu-history' },
        })).toBe(path.resolve('/mnt/pocketrisu-history'))
    })

    it('survives container recreation when only save is retained', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-container-'))
        tempRoots.push(appRoot)
        const savePath = path.join(appRoot, 'save')
        fs.mkdirSync(savePath)
        fs.mkdirSync(path.join(appRoot, 'backups'))
        fs.writeFileSync(path.join(appRoot, 'ephemeral-app-file'), 'old container')
        const rows = new Map<string, Buffer>()
        const expected = rawChat(200, 'persistent pre-image')
        rows.set(rowKey('char', 'chat'), expected)

        const createStore = () => createChatBackupStore({
            getChatBackupsRoot: () => resolveChatBackupDir({
                cwd: appRoot,
                savePath,
                env: {},
            }),
            readChatRowRaw: (chaId: string, chatId: string) => (
                rows.get(rowKey(chaId, chatId)) ?? null
            ),
            cooldownMs: 0,
            autoReconcile: false,
        }) as ChatBackupStore

        const initial = createStore()
        stores.push(initial)
        expect(await initial.captureChatPreImage({ chaId: 'char', chatId: 'chat' }))
            .toBe('captured')
        const [before] = initial.listChatBackups('char', 'chat')
        initial.close()

        for (const entry of fs.readdirSync(appRoot)) {
            if (entry !== 'save') {
                fs.rmSync(path.join(appRoot, entry), { recursive: true, force: true })
            }
        }

        const replacement = createStore()
        stores.push(replacement)
        expect(replacement.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual([before.versionId])
        expect((await replacement.readChatBackup('char', 'chat', before.versionId))?.equals(expected))
            .toBe(true)
    })

    it('captures in hub mode with a read-only app root when save remains writable', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-hub-root-'))
        tempRoots.push(appRoot)
        const savePath = path.join(appRoot, 'save')
        fs.mkdirSync(savePath, { mode: 0o700 })
        const expected = rawChat(201, 'hub pre-image')
        const canEnforceReadOnly = typeof process.getuid === 'function' && process.getuid() !== 0
        if (canEnforceReadOnly) fs.chmodSync(appRoot, 0o500)

        try {
            const root = resolveChatBackupDir({
                cwd: appRoot,
                savePath,
                env: { POCKETRISU_HUB_HOSTING: 'true' },
            })
            const store = createChatBackupStore({
                getChatBackupsRoot: () => root,
                readChatRowRaw: () => expected,
                cooldownMs: 0,
                autoReconcile: false,
            }) as ChatBackupStore
            stores.push(store)

            expect(await store.captureChatPreImage({ chaId: 'hub-char', chatId: 'hub-chat' }))
                .toBe('captured')
            const [version] = store.listChatBackups('hub-char', 'hub-chat')
            expect((await store.readChatBackup('hub-char', 'hub-chat', version.versionId))?.equals(expected))
                .toBe(true)
            expect(root).toBe(path.join(savePath, 'chat-backups'))
            if (canEnforceReadOnly) expect(fs.existsSync(path.join(appRoot, 'backups'))).toBe(false)
        } finally {
            if (canEnforceReadOnly) fs.chmodSync(appRoot, 0o700)
        }
    })

    it('copies cross-root legacy versions without relying on hardlinks', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-migration-'))
        tempRoots.push(appRoot)
        const legacyRoot = path.join(appRoot, 'backups', 'chat-backups')
        const destinationRoot = path.join(appRoot, 'save', 'chat-backups')
        const expected = rawChat(202, 'legacy pre-image')
        const legacyStore = createChatBackupStore({
            getChatBackupsRoot: () => legacyRoot,
            readChatRowRaw: () => expected,
            cooldownMs: 0,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(legacyStore)
        expect(await legacyStore.captureChatPreImage({ chaId: 'char', chatId: 'chat' }))
            .toBe('captured')
        const [legacyVersion] = legacyStore.listChatBackups('char', 'chat')
        legacyStore.close()

        const exdev = Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
        const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
            throw exdev
        })
        let result
        try {
            result = migrateLegacyChatBackups({
                legacyRoot,
                destinationRoot,
                logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            })
        } finally {
            linkSpy.mockRestore()
        }

        expect(result).toMatchObject({ copied: 1, conflicts: 0, failed: 0 })
        expect(linkSpy).not.toHaveBeenCalled()
        expect(fs.existsSync(legacyRoot)).toBe(true)
        const migratedStore = createChatBackupStore({
            getChatBackupsRoot: () => destinationRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(migratedStore)
        expect(migratedStore.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual([legacyVersion.versionId])
        expect((await migratedStore.readChatBackup('char', 'chat', legacyVersion.versionId))?.equals(expected))
            .toBe(true)
    })

    it('deduplicates identical destinations and preserves divergent files separately', () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-migration-conflict-'))
        tempRoots.push(appRoot)
        const legacyRoot = path.join(appRoot, 'legacy')
        const destinationRoot = path.join(appRoot, 'destination')
        fs.mkdirSync(legacyRoot)
        fs.mkdirSync(destinationRoot)
        fs.writeFileSync(path.join(legacyRoot, 'identical.bin'), 'same')
        fs.writeFileSync(path.join(destinationRoot, 'identical.bin'), 'same')
        fs.writeFileSync(path.join(legacyRoot, 'conflict.bin'), 'legacy')
        fs.writeFileSync(path.join(destinationRoot, 'conflict.bin'), 'destination')
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

        const result = migrateLegacyChatBackups({ legacyRoot, destinationRoot, logger })

        expect(result).toMatchObject({ copied: 1, deduplicated: 1, conflicts: 1, failed: 0 })
        expect(fs.existsSync(legacyRoot)).toBe(true)
        expect(fs.readFileSync(path.join(destinationRoot, 'conflict.bin'), 'utf-8'))
            .toBe('destination')
        expect(recursiveSnapshot(path.join(destinationRoot, '%2Eroot-history'))
            .some(entry => Buffer.from(entry.data, 'base64').toString('utf8') === 'legacy'))
            .toBe(true)
        expect(logger.warn).toHaveBeenCalled()
    })

    it('does not migrate a symlink alias of the active root into itself', () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-alias-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'history')
        const aliasRoot = path.join(appRoot, 'history-alias')
        fs.mkdirSync(activeRoot)
        fs.writeFileSync(path.join(activeRoot, 'version.bin'), 'history')
        fs.symlinkSync(activeRoot, aliasRoot, 'dir')

        expect(migrateLegacyChatBackups({
            legacyRoot: aliasRoot,
            destinationRoot: activeRoot,
        })).toEqual({ copied: 0, deduplicated: 0, conflicts: 0, failed: 0 })
        expect(fs.readFileSync(path.join(activeRoot, 'version.bin'), 'utf8')).toBe('history')
        expect(fs.readFileSync(path.join(aliasRoot, 'version.bin'), 'utf8')).toBe('history')
    })

    it('merges A to B and B to the default root while captures follow the active root', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-chain-'))
        tempRoots.push(appRoot)
        const rootA = path.join(appRoot, 'history-a')
        const rootB = path.join(appRoot, 'history-b')
        const defaultRoot = path.join(appRoot, 'save', 'chat-backups')
        const rows = new Map<string, Buffer>()
        let clock = 10_000
        const first = rawChat(203, 'root A')
        const second = rawChat(204, 'root B')
        rows.set(rowKey('char', 'chat'), first)

        const createStore = (activeRoot: string, readRoots: string[]) => createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => readRoots,
            readChatRowRaw: (chaId: string, chatId: string) => (
                rows.get(rowKey(chaId, chatId)) ?? null
            ),
            now: () => clock,
            cooldownMs: 0,
            autoReconcile: false,
        }) as ChatBackupStore

        const storeA = createStore(rootA, [rootA])
        stores.push(storeA)
        expect(await storeA.captureChatPreImage({ chaId: 'char', chatId: 'chat' }))
            .toBe('captured')
        const firstVersion = storeA.listChatBackups('char', 'chat')[0]
        storeA.close()

        expect(migrateLegacyChatBackups({
            legacyRoot: rootA,
            destinationRoot: rootB,
        })).toMatchObject({ copied: 1, conflicts: 0, failed: 0 })
        const storeB = createStore(rootB, [rootB, rootA])
        stores.push(storeB)
        expect((await storeB.readChatBackup('char', 'chat', firstVersion.versionId))?.equals(first))
            .toBe(true)

        clock++
        rows.set(rowKey('char', 'chat'), second)
        expect(await storeB.captureChatPreImage({ chaId: 'char', chatId: 'chat' }))
            .toBe('captured')
        const secondVersion = storeB.listChatBackups('char', 'chat')[0]
        expect(fs.existsSync(path.join(
            rootB,
            encodeURIComponent('char'),
            encodeURIComponent('chat'),
            `${secondVersion.versionId}.bin`,
        ))).toBe(true)
        storeB.close()

        expect(migrateLegacyChatBackups({
            legacyRoot: rootB,
            destinationRoot: defaultRoot,
        })).toMatchObject({ copied: 3, conflicts: 0, failed: 0 })
        const defaultStore = createStore(defaultRoot, [defaultRoot, rootB, rootA])
        stores.push(defaultStore)
        expect(defaultStore.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual([secondVersion.versionId, firstVersion.versionId])
        expect((await defaultStore.readChatBackup('char', 'chat', firstVersion.versionId))?.equals(first))
            .toBe(true)
        expect((await defaultStore.readChatBackup('char', 'chat', secondVersion.versionId))?.equals(second))
            .toBe(true)
    })

    it('federates divergent version-ID conflicts without overwriting either history', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-conflict-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const versionId = 'v-20000-0-root-change'
        const historical = rawChat(205, 'historical conflict')
        const active = rawChat(206, 'active conflict')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(path.join(historicalDir, `${versionId}.bin`), historical)
        fs.writeFileSync(path.join(activeDir, `${versionId}.bin`), active)

        expect(migrateLegacyChatBackups({
            legacyRoot: historicalRoot,
            destinationRoot: activeRoot,
        })).toMatchObject({ copied: 1, conflicts: 1, failed: 0 })

        const createStore = () => createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        const firstStore = createStore()
        stores.push(firstStore)
        const versions = firstStore.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        expect(new Set(versions.map(version => version.versionId)).size).toBe(2)
        const bodies = await Promise.all(versions.map(version => (
            firstStore.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(bodies.map(body => body?.toString('base64'))))
            .toEqual(new Set([active.toString('base64'), historical.toString('base64')]))
        firstStore.close()

        const restarted = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(restarted)
        expect(restarted.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual(versions.map(version => version.versionId))
        for (const version of versions) {
            expect(await restarted.readChatBackup('char', 'chat', version.versionId)).not.toBeNull()
        }
        expect(fs.existsSync(historicalRoot)).toBe(true)
        expect(fs.readFileSync(path.join(activeDir, `${versionId}.bin`))).toEqual(active)
        expect(recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))
            .some(entry => entry.data === historical.toString('base64'))).toBe(true)

        restarted.close()
        const defaultRoot = path.join(appRoot, 'save', 'chat-backups')
        expect(migrateLegacyChatBackups({
            legacyRoot: activeRoot,
            destinationRoot: defaultRoot,
        })).toMatchObject({ copied: 2, conflicts: 0, failed: 0 })
        const defaultStore = createChatBackupStore({
            getChatBackupsRoot: () => defaultRoot,
            getChatBackupsReadRoots: () => [defaultRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(defaultStore)
        const defaultVersions = defaultStore.listChatBackups('char', 'chat')
        expect(defaultVersions.map(version => version.versionId))
            .toEqual(versions.map(version => version.versionId))
        const defaultBodies = await Promise.all(defaultVersions.map(version => (
            defaultStore.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(defaultBodies.map(body => body?.toString('base64'))))
            .toEqual(new Set([active.toString('base64'), historical.toString('base64')]))
    })

    it('keeps an interrupted merge readable and retries it safely after restart', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-retry-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        fs.mkdirSync(historicalDir, { recursive: true })
        const fixtures = [
            ['v-30000-0-first.bin', rawChat(207, 'first')],
            ['v-30001-0-second.bin', rawChat(208, 'second')],
        ] as const
        for (const [filename, bytes] of fixtures) {
            fs.writeFileSync(path.join(historicalDir, filename), bytes)
        }

        const injected = Object.assign(new Error('interrupted root migration'), { code: 'EIO' })
        const interruptedDestination = path.join(activeRoot, 'char', 'chat', fixtures[0][0])
        const realCopy = fs.copyFileSync.bind(fs)
        let injectedOnce = false
        const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, mode) => {
            if (!injectedOnce
                && path.resolve(String(destination)) === path.resolve(interruptedDestination)) {
                injectedOnce = true
                throw injected
            }
            return realCopy(source, destination, mode)
        })
        let interrupted
        try {
            interrupted = migrateLegacyChatBackups({ legacyRoot: historicalRoot, destinationRoot: activeRoot })
        } finally {
            copySpy.mockRestore()
        }
        expect(interrupted).toMatchObject({ copied: 1, failed: 1 })

        const duringInterruption = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(duringInterruption)
        expect(duringInterruption.listChatBackups('char', 'chat')).toHaveLength(2)
        duringInterruption.close()

        expect(migrateLegacyChatBackups({ legacyRoot: historicalRoot, destinationRoot: activeRoot }))
            .toMatchObject({ copied: 1, conflicts: 0, failed: 0 })
        const restarted = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(restarted)
        const versions = restarted.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        for (const version of versions) {
            expect(await restarted.readChatBackup('char', 'chat', version.versionId)).not.toBeNull()
        }
        expect(fs.existsSync(historicalRoot)).toBe(true)
    })

    it('keeps a conflicting legacy bundle and metadata together', () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-bundle-root-conflict-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        const bundle = 'archive-40000-40000.bundle'
        const meta = 'archive-40000-40000.meta.json'
        fs.writeFileSync(path.join(historicalDir, bundle), 'historical bundle')
        fs.writeFileSync(path.join(historicalDir, meta), 'historical metadata')
        fs.writeFileSync(path.join(activeDir, bundle), 'active bundle')

        const result = migrateLegacyChatBackups({
            legacyRoot: historicalRoot,
            destinationRoot: activeRoot,
        })

        expect(result).toMatchObject({ copied: 2, conflicts: 1, failed: 0 })
        expect(fs.existsSync(historicalRoot)).toBe(true)
        expect(fs.readFileSync(path.join(activeDir, bundle), 'utf8')).toBe('active bundle')
        expect(fs.existsSync(path.join(activeDir, meta))).toBe(false)
        const preserved = recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))
        expect(preserved.some(entry => Buffer.from(entry.data, 'base64').toString('utf8')
            === 'historical bundle')).toBe(true)
        expect(preserved.some(entry => Buffer.from(entry.data, 'base64').toString('utf8')
            === 'historical metadata')).toBe(true)
    })

    it('never overwrites a destination created during create-only publication', () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-race-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const versionId = 'v-45000-0-race'
        const historical = rawChat(212, 'historical race source')
        const active = rawChat(213, 'racing active destination')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(path.join(historicalDir, `${versionId}.bin`), historical)

        const destination = path.join(activeDir, `${versionId}.bin`)
        const realCopy = fs.copyFileSync.bind(fs)
        let injectedOnce = false
        const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
            if (!injectedOnce && path.resolve(String(target)) === path.resolve(destination)) {
                injectedOnce = true
                fs.writeFileSync(target, active)
                throw Object.assign(new Error('destination appeared'), { code: 'EEXIST' })
            }
            return realCopy(source, target, mode)
        })
        let result
        try {
            result = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })
        } finally {
            copySpy.mockRestore()
        }

        expect(result).toMatchObject({ conflicts: 1, failed: 0 })
        expect(fs.readFileSync(path.join(activeDir, `${versionId}.bin`))).toEqual(active)
        expect(recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))
            .some(entry => entry.data === historical.toString('base64'))).toBe(true)
    })

    it('never unlinks a source file and safely federates a later source replacement', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-source-replace-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const versionId = 'v-45500-0-source-replace'
        const source = path.join(historicalDir, `${versionId}.bin`)
        const historical = rawChat(221, 'retained source history')
        const peer = rawChat(222, 'later source replacement')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(source, historical)

        const realUnlink = fs.unlinkSync.bind(fs)
        let sourceUnlinks = 0
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            if (path.resolve(String(filename)) === path.resolve(source)) sourceUnlinks++
            return realUnlink(filename)
        })
        let result
        try {
            result = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })
        } finally {
            unlinkSpy.mockRestore()
        }

        expect(sourceUnlinks).toBe(0)
        expect(result).toMatchObject({ copied: 1, conflicts: 0, failed: 0 })
        expect(fs.readFileSync(source)).toEqual(historical)
        expect(recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))
            .some(entry => entry.data === historical.toString('base64'))).toBe(true)

        fs.writeFileSync(source, peer)

        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)
        const versions = store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        const bodies = await Promise.all(versions.map(version => (
            store.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(bodies.map(body => body?.toString('base64')))).toEqual(new Set([
            historical.toString('base64'),
            peer.toString('base64'),
        ]))
        const retry = migrateLegacyChatBackups({
            legacyRoot: historicalRoot,
            destinationRoot: activeRoot,
        })
        expect(retry).toMatchObject({ copied: 1, conflicts: 1, failed: 0 })
        expect(fs.readFileSync(source)).toEqual(peer)
        const afterRetry = store.listChatBackups('char', 'chat')
        expect(afterRetry).toHaveLength(2)
        const afterRetryBodies = await Promise.all(afterRetry.map(version => (
            store.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(afterRetryBodies.map(body => body?.toString('base64')))).toEqual(new Set([
            historical.toString('base64'),
            peer.toString('base64'),
        ]))
    })

    it('keeps protected single-file bytes independent from a later in-place direct write', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-late-replace-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const versionId = 'v-45600-0-late-replace'
        const historical = rawChat(226, 'durable protected source')
        const peer = rawChat(227, 'late peer replacement')
        const destination = path.join(activeDir, `${versionId}.bin`)
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(path.join(historicalDir, `${versionId}.bin`), historical)

        const realUnlink = fs.unlinkSync.bind(fs)
        let protectedUnlinks = 0
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            if (String(filename).includes('%2Eroot-history')) protectedUnlinks++
            return realUnlink(filename)
        })
        let result
        try {
            result = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })
        } finally {
            unlinkSpy.mockRestore()
        }
        expect(result).toMatchObject({ copied: 1, conflicts: 0, failed: 0 })
        expect(protectedUnlinks).toBe(0)
        expect(recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))
            .some(entry => entry.data === historical.toString('base64'))).toBe(true)

        fs.writeFileSync(destination, peer)
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)
        const versions = store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        const bodies = await Promise.all(versions.map(version => (
            store.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(bodies.map(body => body?.toString('base64')))).toEqual(new Set([
            historical.toString('base64'),
            peer.toString('base64'),
        ]))
    })

    it('never unlinks a source bundle and safely federates a later source replacement', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-bundle-source-replace-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const peerDir = path.join(appRoot, 'peer')
        const versionId = 'v-45700-0-source-bundle'
        const historical = rawChat(231, 'retained source bundle')
        const peer = rawChat(232, 'later source bundle replacement')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.mkdirSync(peerDir, { recursive: true })
        const { bundleFile } = writeLegacySolidBundle(historicalDir, [{
            versionId,
            raw: historical,
        }])
        const metaFile = bundleFile.replace(/\.bundle$/, '.meta.json')
        const sourceBundle = path.join(historicalDir, bundleFile)
        const sourceMeta = path.join(historicalDir, metaFile)

        const realUnlink = fs.unlinkSync.bind(fs)
        let sourceUnlinks = 0
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            const absolute = path.resolve(String(filename))
            if (absolute === path.resolve(sourceBundle)
                || absolute === path.resolve(sourceMeta)) {
                sourceUnlinks++
            }
            return realUnlink(filename)
        })
        let first
        let retry
        try {
            first = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })

            writeLegacySolidBundle(peerDir, [{ versionId, raw: peer }])
            fs.writeFileSync(sourceBundle, fs.readFileSync(path.join(peerDir, bundleFile)))
            fs.writeFileSync(sourceMeta, fs.readFileSync(path.join(peerDir, metaFile)))

            const store = createChatBackupStore({
                getChatBackupsRoot: () => activeRoot,
                getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
                readChatRowRaw: () => null,
                autoReconcile: false,
            }) as ChatBackupStore
            stores.push(store)
            const versions = store.listChatBackups('char', 'chat')
            expect(versions).toHaveLength(2)
            const bodies = await Promise.all(versions.map(version => (
                store.readChatBackup('char', 'chat', version.versionId)
            )))
            expect(new Set(bodies.map(body => body?.toString('base64')))).toEqual(new Set([
                historical.toString('base64'),
                peer.toString('base64'),
            ]))

            retry = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })
            const afterRetry = store.listChatBackups('char', 'chat')
            expect(afterRetry).toHaveLength(2)
            const afterRetryBodies = await Promise.all(afterRetry.map(version => (
                store.readChatBackup('char', 'chat', version.versionId)
            )))
            expect(new Set(afterRetryBodies.map(body => body?.toString('base64')))).toEqual(new Set([
                historical.toString('base64'),
                peer.toString('base64'),
            ]))
        } finally {
            unlinkSpy.mockRestore()
        }

        expect(sourceUnlinks).toBe(0)
        expect(first).toMatchObject({ copied: 2, conflicts: 0, failed: 0 })
        expect(retry).toMatchObject({ copied: 2, conflicts: 1, failed: 0 })
        expect(fs.existsSync(sourceBundle)).toBe(true)
        expect(fs.existsSync(sourceMeta)).toBe(true)
        const preservedBodies = recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))
            .map(entry => entry.data)
        expect(preservedBodies).toContain(fs.readFileSync(sourceBundle).toString('base64'))
    })

    it('keeps protected bundle bytes independent from later in-place direct writes', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-bundle-late-replace-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const peerDir = path.join(appRoot, 'peer')
        const versionId = 'v-45750-0-late-bundle'
        const historical = rawChat(228, 'protected bundle body')
        const peer = rawChat(229, 'late peer bundle body')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.mkdirSync(peerDir, { recursive: true })
        const { bundleFile } = writeLegacySolidBundle(historicalDir, [{
            versionId,
            raw: historical,
        }])

        const realUnlink = fs.unlinkSync.bind(fs)
        let protectedUnlinks = 0
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            if (String(filename).includes('%2Eroot-history')) protectedUnlinks++
            return realUnlink(filename)
        })
        let result
        try {
            result = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })
        } finally {
            unlinkSpy.mockRestore()
        }
        expect(result).toMatchObject({ copied: 2, conflicts: 0, failed: 0 })
        expect(protectedUnlinks).toBe(0)

        writeLegacySolidBundle(peerDir, [{ versionId, raw: peer }])
        const metaFile = bundleFile.replace(/\.bundle$/, '.meta.json')
        fs.writeFileSync(
            path.join(activeDir, bundleFile),
            fs.readFileSync(path.join(peerDir, bundleFile)),
        )
        fs.writeFileSync(
            path.join(activeDir, metaFile),
            fs.readFileSync(path.join(peerDir, metaFile)),
        )

        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)
        const versions = store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        const bodies = await Promise.all(versions.map(version => (
            store.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(bodies.map(body => body?.toString('base64')))).toEqual(new Set([
            historical.toString('base64'),
            peer.toString('base64'),
        ]))
    })

    it('derives protected bundle frames without removing source files across restart', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-protected-normalize-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const versionId = 'v-45775-0-protected-normalize'
        const historical = rawChat(230, 'protected normalized bundle body')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        const { bundleFile } = writeLegacySolidBundle(historicalDir, [{
            versionId,
            raw: historical,
        }])
        const metaFile = bundleFile.replace(/\.bundle$/, '.meta.json')
        expect(migrateLegacyChatBackups({
            legacyRoot: historicalRoot,
            destinationRoot: activeRoot,
        })).toMatchObject({ copied: 2, conflicts: 0, failed: 0 })
        const protectedRoot = path.join(activeRoot, '%2Eroot-history')
        let protectedGroup = recursiveSnapshot(protectedRoot)
        expect(protectedGroup.some(entry => entry.name.endsWith(bundleFile))).toBe(true)
        expect(protectedGroup.some(entry => entry.name.endsWith(metaFile))).toBe(true)

        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)
        const normalized = await store.normalizeChatBackups()
        expect(normalized.legacyBundlesMigrated).toBeGreaterThanOrEqual(2)
        protectedGroup = recursiveSnapshot(protectedRoot)
        expect(protectedGroup.some(entry => entry.name.endsWith(bundleFile))).toBe(true)
        expect(protectedGroup.some(entry => entry.name.endsWith(metaFile))).toBe(true)
        expect(protectedGroup.some(entry => entry.name.endsWith(`${versionId}.frame`))).toBe(true)

        let versions = store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(1)
        expect(await store.readChatBackup('char', 'chat', versions[0].versionId))
            .toEqual(historical)

        store.close()
        const restarted = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(restarted)
        await restarted.normalizeChatBackups()
        versions = restarted.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(1)
        expect(await restarted.readChatBackup('char', 'chat', versions[0].versionId))
            .toEqual(historical)
        protectedGroup = recursiveSnapshot(protectedRoot)
        expect(protectedGroup.some(entry => entry.name.endsWith(bundleFile))).toBe(true)
        expect(protectedGroup.some(entry => entry.name.endsWith(metaFile))).toBe(true)
        expect(protectedGroup.some(entry => entry.name.endsWith(`${versionId}.frame`))).toBe(true)
        expect(fs.existsSync(path.join(historicalDir, bundleFile))).toBe(true)
        expect(fs.existsSync(path.join(historicalDir, metaFile))).toBe(true)
    })

    it('keeps loose aliases stable when the second finalization callback replaces the source', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-normalize-loose-race-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const versionId = 'v-45780-0-normalize-loose-race'
        const source = path.join(historicalDir, `${versionId}.bin`)
        const historical = rawChat(233, 'loose before normalization race')
        const peer = rawChat(234, 'loose peer at finalization boundary')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeRoot, { recursive: true })
        fs.writeFileSync(source, historical)

        let replaced = false
        let finalizations = 0
        const diagnostics = {
            onEvent: (event: Record<string, any>) => {
                if (event.event === 'normalization-source-finalize'
                    && event.retainSource === true
                    && path.resolve(String(event.source)) === path.resolve(source)) {
                    finalizations++
                    if (!replaced && finalizations === 2) {
                        fs.writeFileSync(source, peer)
                        replaced = true
                    }
                }
            },
        }
        const createStore = () => createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
            diagnostics,
        }) as ChatBackupStore
        const realUnlink = fs.unlinkSync.bind(fs)
        let sourceUnlinks = 0
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            if (path.resolve(String(filename)) === path.resolve(source)) sourceUnlinks++
            return realUnlink(filename)
        })
        const store = createStore()
        stores.push(store)
        let versionIds: string[] = []
        try {
            await store.normalizeChatBackups()
            expect(replaced).toBe(true)
            expect(finalizations).toBe(2)
            expect(fs.readFileSync(source)).toEqual(peer)
            const versions = store.listChatBackups('char', 'chat')
            expect(versions).toHaveLength(2)
            versionIds = versions.map(version => version.versionId)
            const bodies = await Promise.all(versions.map(version => (
                store.readChatBackup('char', 'chat', version.versionId)
            )))
            expect(new Set(bodies.map(body => body?.toString('base64')))).toEqual(new Set([
                historical.toString('base64'),
                peer.toString('base64'),
            ]))

            store.close()
            const restarted = createStore()
            stores.push(restarted)
            await restarted.normalizeChatBackups()
            const restartedVersions = restarted.listChatBackups('char', 'chat')
            expect(restartedVersions.map(version => version.versionId)).toEqual(versionIds)
            const restartedBodies = await Promise.all(restartedVersions.map(version => (
                restarted.readChatBackup('char', 'chat', version.versionId)
            )))
            expect(new Set(restartedBodies.map(body => body?.toString('base64')))).toEqual(new Set([
                historical.toString('base64'),
                peer.toString('base64'),
            ]))
            expect(fs.readFileSync(source)).toEqual(peer)
        } finally {
            unlinkSpy.mockRestore()
        }
        expect(sourceUnlinks).toBe(0)
    })

    it('keeps bundle aliases stable when the final cache-stat reread replaces the source', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-normalize-bundle-race-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const peerDir = path.join(appRoot, 'peer')
        const versionId = 'v-45785-0-normalize-bundle-race'
        const historical = rawChat(235, 'bundle before normalization race')
        const peer = rawChat(236, 'bundle peer at finalization boundary')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeRoot, { recursive: true })
        fs.mkdirSync(peerDir, { recursive: true })
        const { bundleFile } = writeLegacySolidBundle(historicalDir, [{
            versionId,
            raw: historical,
        }])
        writeLegacySolidBundle(peerDir, [{ versionId, raw: peer }])
        const metaFile = bundleFile.replace(/\.bundle$/, '.meta.json')
        const sourceBundle = path.join(historicalDir, bundleFile)
        const sourceMeta = path.join(historicalDir, metaFile)
        const peerBundle = path.join(peerDir, bundleFile)
        const peerMeta = path.join(peerDir, metaFile)

        let replaced = false
        let finalizationWindow = false
        const diagnostics = {
            onEvent: (event: Record<string, any>) => {
                if (event.event === 'normalization-source-finalize'
                    && event.sourceStorage === 'legacy-bundle'
                    && event.retainSource === true
                    && path.resolve(String(event.source)) === path.resolve(sourceBundle)) {
                    finalizationWindow = true
                }
            },
        }
        const createStore = () => createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
            diagnostics,
        }) as ChatBackupStore
        const realUnlink = fs.unlinkSync.bind(fs)
        const realStat = fs.statSync.bind(fs)
        let sourceUnlinks = 0
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            const absolute = path.resolve(String(filename))
            if (absolute === path.resolve(sourceBundle)
                || absolute === path.resolve(sourceMeta)) sourceUnlinks++
            return realUnlink(filename)
        })
        const statSpy = vi.spyOn(fs, 'statSync').mockImplementation((filename) => {
            const result = realStat(filename)
            if (finalizationWindow
                && !replaced
                && path.resolve(String(filename)) === path.resolve(sourceMeta)) {
                fs.writeFileSync(sourceBundle, fs.readFileSync(peerBundle))
                fs.writeFileSync(sourceMeta, fs.readFileSync(peerMeta))
                replaced = true
            }
            return result
        })
        const store = createStore()
        stores.push(store)
        let versionIds: string[] = []
        try {
            await store.normalizeChatBackups()
            expect(replaced).toBe(true)
            expect(fs.readFileSync(sourceBundle)).toEqual(fs.readFileSync(peerBundle))
            expect(fs.readFileSync(sourceMeta)).toEqual(fs.readFileSync(peerMeta))
            const versions = store.listChatBackups('char', 'chat')
            expect(versions).toHaveLength(2)
            versionIds = versions.map(version => version.versionId)
            const bodies = await Promise.all(versions.map(version => (
                store.readChatBackup('char', 'chat', version.versionId)
            )))
            expect(new Set(bodies.map(body => body?.toString('base64')))).toEqual(new Set([
                historical.toString('base64'),
                peer.toString('base64'),
            ]))

            store.close()
            const restarted = createStore()
            stores.push(restarted)
            await restarted.normalizeChatBackups()
            const restartedVersions = restarted.listChatBackups('char', 'chat')
            expect(restartedVersions.map(version => version.versionId)).toEqual(versionIds)
            const restartedBodies = await Promise.all(restartedVersions.map(version => (
                restarted.readChatBackup('char', 'chat', version.versionId)
            )))
            expect(new Set(restartedBodies.map(body => body?.toString('base64')))).toEqual(new Set([
                historical.toString('base64'),
                peer.toString('base64'),
            ]))
            expect(fs.readFileSync(sourceBundle)).toEqual(fs.readFileSync(peerBundle))
            expect(fs.readFileSync(sourceMeta)).toEqual(fs.readFileSync(peerMeta))
        } finally {
            statSpy.mockRestore()
            unlinkSpy.mockRestore()
        }
        expect(sourceUnlinks).toBe(0)
    })

    it('keeps every recognized backup file under the reserved namespace untouched', async () => {
        const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-reserved-reconcile-'))
        tempRoots.push(activeRoot)
        const reserved = path.join(activeRoot, '%2Eroot-history', 'namespace')
        const oddDepth = path.join(reserved, 'odd', 'depth')
        fs.mkdirSync(reserved, { recursive: true })
        fs.mkdirSync(oddDepth, { recursive: true })
        fs.writeFileSync(
            path.join(reserved, 'v-45786-0-reserved.bin'),
            rawChat(237, 'reserved shallow loose'),
        )
        fs.writeFileSync(
            path.join(reserved, 'v-45787-0-reserved.bin.gz'),
            zlib.gzipSync(rawChat(238, 'reserved shallow gzip')),
        )
        writeLegacySolidBundle(reserved, [{
            versionId: 'v-45788-0-reserved',
            raw: rawChat(239, 'reserved shallow bundle'),
        }])
        fs.writeFileSync(
            path.join(oddDepth, 'v-45789-0-reserved.bin'),
            rawChat(240, 'reserved odd-depth loose'),
        )
        const before = recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))

        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)
        await store.reconcileChatBackups()

        expect(recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))).toEqual(before)
    })

    it('never removes a peer-owned predicted frame temp after exclusive-create collision', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-frame-temp-owner-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const historicalRoot = path.join(appRoot, 'historical')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const versionId = 'v-45790-0-peer-temp'
        const source = path.join(historicalDir, `${versionId}.bin`)
        const destination = path.join(historicalDir, `${versionId}.frame`)
        const predictedTemp = `${destination}.${process.pid}-0.tmp`
        const peerTemp = Buffer.from('peer-owned predicted normalization temp')
        fs.mkdirSync(activeRoot, { recursive: true })
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.writeFileSync(source, rawChat(241, 'peer temp source'))
        fs.writeFileSync(predictedTemp, peerTemp)

        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }) as ChatBackupStore
        stores.push(store)
        const normalized = await store.normalizeChatBackups()

        expect(fs.existsSync(predictedTemp)).toBe(true)
        expect(fs.readFileSync(predictedTemp)).toEqual(peerTemp)
        expect(fs.existsSync(source)).toBe(true)
        expect(fs.existsSync(destination)).toBe(true)
        expect(normalized.conflictsPreserved).toBe(0)
        expect(recursiveSnapshot(path.join(activeRoot, '%2Eroot-history'))).toEqual([])
    })

    it('invalidates a frame semantic cache when only ctime reveals an equal-size overwrite', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-frame-ctime-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const historicalRoot = path.join(appRoot, 'historical')
        const peerRoot = path.join(appRoot, 'peer')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const peerDir = path.join(peerRoot, 'char', 'chat')
        const versionId = 'v-45795-0-frame-ctime'
        const historical = Buffer.alloc(4_096, 0x41)
        const peer = Buffer.alloc(4_096, 0x42)
        writeFrameFixture(activeDir, versionId, historical)
        writeFrameFixture(historicalDir, versionId, historical)
        writeFrameFixture(peerDir, versionId, peer)
        const activeFrame = path.join(activeDir, `${versionId}.frame`)
        const peerFrame = path.join(peerDir, `${versionId}.frame`)
        expect(fs.statSync(activeFrame).size).toBe(fs.statSync(peerFrame).size)
        const stableTime = new Date(1_700_000_000_000)
        fs.utimesSync(activeFrame, stableTime, stableTime)

        const createStore = () => createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        const live = createStore()
        stores.push(live)
        await live.normalizeChatBackups()
        const cachedStat = fs.statSync(activeFrame)
        fs.writeFileSync(activeFrame, fs.readFileSync(peerFrame))
        fs.utimesSync(activeFrame, stableTime, stableTime)
        const replacedStat = fs.statSync(activeFrame)
        expect(replacedStat.ino).toBe(cachedStat.ino)
        expect(replacedStat.size).toBe(cachedStat.size)
        expect(replacedStat.mtimeMs).toBe(cachedStat.mtimeMs)
        expect(replacedStat.ctimeMs).not.toBe(cachedStat.ctimeMs)

        const bodyToId = async (store: ChatBackupStore) => {
            const versions = store.listChatBackups('char', 'chat')
            expect(versions).toHaveLength(2)
            const mapping = new Map<string, string>()
            for (const version of versions) {
                const body = await store.readChatBackup('char', 'chat', version.versionId)
                expect(body).not.toBeNull()
                mapping.set(body!.toString('base64'), version.versionId)
            }
            return mapping
        }
        const liveMapping = await bodyToId(live)
        expect(new Set(liveMapping.keys())).toEqual(new Set([
            historical.toString('base64'),
            peer.toString('base64'),
        ]))

        const fresh = createStore()
        stores.push(fresh)
        await fresh.normalizeChatBackups()
        expect(await bodyToId(fresh)).toEqual(liveMapping)
    })

    it('does not cache decoded frame semantics under an atomically replaced path', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-frame-identity-race-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const historicalRoot = path.join(appRoot, 'historical')
        const peerRoot = path.join(appRoot, 'peer')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const peerDir = path.join(peerRoot, 'char', 'chat')
        const versionId = 'v-45797-0-frame-identity-race'
        const historical = rawChat(242, 'frame decoded before replacement')
        const peer = rawChat(243, 'frame installed before cache fingerprint')
        writeFrameFixture(activeDir, versionId, historical)
        writeFrameFixture(historicalDir, versionId, historical)
        writeFrameFixture(peerDir, versionId, peer)
        const activeFrame = path.join(activeDir, `${versionId}.frame`)
        const peerFrame = path.join(peerDir, `${versionId}.frame`)

        let replaced = false
        const diagnostics = {
            onEvent: (event: Record<string, any>) => {
                if (!replaced
                    && event.event === 'decompress-end'
                    && event.operation === 'startup-normalize-frame'
                    && event.versionId === versionId) {
                    fs.renameSync(peerFrame, activeFrame)
                    replaced = true
                }
            },
        }
        const createStore = () => createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
            diagnostics,
        }) as ChatBackupStore
        const bodyToId = async (store: ChatBackupStore) => {
            const versions = store.listChatBackups('char', 'chat')
            expect(versions).toHaveLength(2)
            const mapping = new Map<string, string>()
            for (const version of versions) {
                const body = await store.readChatBackup('char', 'chat', version.versionId)
                expect(body).not.toBeNull()
                mapping.set(body!.toString('base64'), version.versionId)
            }
            return mapping
        }

        const live = createStore()
        stores.push(live)
        const normalized = await live.normalizeChatBackups()
        expect(replaced).toBe(true)
        expect(normalized.framesInvalid).toBeGreaterThanOrEqual(1)
        const liveMapping = await bodyToId(live)
        expect(new Set(liveMapping.keys())).toEqual(new Set([
            historical.toString('base64'),
            peer.toString('base64'),
        ]))

        live.close()
        const restarted = createStore()
        stores.push(restarted)
        await restarted.normalizeChatBackups()
        expect(await bodyToId(restarted)).toEqual(liveMapping)
    })

    it('retains the source when the published destination file cannot be fsynced', () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-file-fsync-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const filename = 'v-45800-0-file-fsync.bin'
        const source = path.join(historicalDir, filename)
        const destination = path.join(activeDir, filename)
        const historical = rawChat(223, 'destination file fsync source')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(source, historical)

        const realFsync = fs.fsyncSync.bind(fs)
        let failedDestination = false
        const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
            if (!failedDestination && fs.existsSync(destination)) {
                const opened = fs.fstatSync(fd)
                const destinationStat = fs.statSync(destination)
                if (opened.isFile()
                    && opened.dev === destinationStat.dev
                    && opened.ino === destinationStat.ino) {
                    failedDestination = true
                    throw Object.assign(new Error('injected destination-file fsync failure'), {
                        code: 'EIO',
                    })
                }
            }
            return realFsync(fd)
        })
        let result
        try {
            result = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })
        } finally {
            fsyncSpy.mockRestore()
        }

        expect(failedDestination).toBe(true)
        expect(result).toMatchObject({ copied: 0, failed: 1 })
        expect(fs.readFileSync(source)).toEqual(historical)
        expect(fs.readFileSync(destination)).toEqual(historical)
        expect(migrateLegacyChatBackups({
            legacyRoot: historicalRoot,
            destinationRoot: activeRoot,
        })).toMatchObject({ deduplicated: 1, failed: 0 })
        expect(fs.existsSync(historicalRoot)).toBe(true)
    })

    it('retains the source when a newly-created recovery parent cannot be fsynced', () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-fsync-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const filename = 'v-46000-0-fsync.bin'
        const historical = rawChat(214, 'fsync source')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(path.join(historicalDir, filename), historical)

        const parentStat = fs.statSync(activeRoot)
        const realFsync = fs.fsyncSync.bind(fs)
        const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
            const opened = fs.fstatSync(fd)
            if (opened.isDirectory()
                && opened.dev === parentStat.dev
                && opened.ino === parentStat.ino) {
                throw Object.assign(new Error('injected new-parent fsync failure'), { code: 'EIO' })
            }
            return realFsync(fd)
        })
        let result
        try {
            result = migrateLegacyChatBackups({
                legacyRoot: historicalRoot,
                destinationRoot: activeRoot,
            })
        } finally {
            fsyncSpy.mockRestore()
        }

        expect(result).toMatchObject({ copied: 0, failed: 1 })
        expect(fs.readFileSync(path.join(historicalDir, filename))).toEqual(historical)
        expect(fs.existsSync(path.join(activeDir, filename))).toBe(false)
        expect(migrateLegacyChatBackups({
            legacyRoot: historicalRoot,
            destinationRoot: activeRoot,
        })).toMatchObject({ copied: 1, failed: 0 })
        expect(fs.existsSync(historicalRoot)).toBe(true)
    })

    it('normalizes same-ID frame, loose, gzip, and bundle history without hiding divergence', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-formats-'))
        tempRoots.push(appRoot)
        const roots = {
            active: path.join(appRoot, 'active'),
            loose: path.join(appRoot, 'loose'),
            gzip: path.join(appRoot, 'gzip'),
            bundle: path.join(appRoot, 'bundle'),
            duplicate: path.join(appRoot, 'duplicate'),
        }
        const versionId = 'v-47000-0-format-conflict'
        const bodies = {
            active: rawChat(215, 'active frame'),
            loose: rawChat(216, 'historical loose'),
            gzip: rawChat(217, 'historical gzip'),
            bundle: rawChat(218, 'historical bundle'),
        }
        const directory = (root: string) => path.join(root, 'char', 'chat')
        writeFrameFixture(directory(roots.active), versionId, bodies.active)
        fs.mkdirSync(directory(roots.loose), { recursive: true })
        fs.writeFileSync(path.join(directory(roots.loose), `${versionId}.bin`), bodies.loose)
        fs.mkdirSync(directory(roots.gzip), { recursive: true })
        fs.writeFileSync(
            path.join(directory(roots.gzip), `${versionId}.bin.gz`),
            zlib.gzipSync(bodies.gzip),
        )
        fs.mkdirSync(directory(roots.bundle), { recursive: true })
        writeLegacySolidBundle(directory(roots.bundle), [{ versionId, raw: bodies.bundle }])
        fs.mkdirSync(directory(roots.duplicate), { recursive: true })
        fs.writeFileSync(
            path.join(directory(roots.duplicate), `${versionId}.bin`),
            bodies.active,
        )

        const makeStore = (readRoots: string[]) => createChatBackupStore({
            getChatBackupsRoot: () => roots.active,
            getChatBackupsReadRoots: () => readRoots,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        const bodyToId = async (store: ChatBackupStore) => {
            const mapping = new Map<string, string>()
            for (const version of store.listChatBackups('char', 'chat')) {
                const body = await store.readChatBackup('char', 'chat', version.versionId)
                expect(body).not.toBeNull()
                mapping.set(body!.toString('base64'), version.versionId)
                const sequence = Number(version.versionId.split('-')[2])
                expect(Number.isSafeInteger(sequence)).toBe(true)
            }
            return mapping
        }

        const first = makeStore(Object.values(roots))
        stores.push(first)
        const normalized = await first.normalizeChatBackups()
        expect(normalized.legacyBundlesMigrated).toBe(1)
        expect(normalized.looseVersionsConverted).toBe(0)
        expect(fs.existsSync(path.join(directory(roots.loose), `${versionId}.bin`))).toBe(true)
        expect(fs.existsSync(path.join(directory(roots.gzip), `${versionId}.bin.gz`))).toBe(true)
        expect(recursiveSnapshot(directory(roots.bundle))
            .some(entry => entry.name.endsWith('.bundle'))).toBe(true)
        expect(recursiveSnapshot(directory(roots.bundle))
            .some(entry => entry.name.endsWith('.meta.json'))).toBe(true)
        await first.reconcileChatBackups()
        const firstMapping = await bodyToId(first)
        expect(firstMapping.size).toBe(4)
        expect(new Set(firstMapping.keys())).toEqual(new Set(
            Object.values(bodies).map(body => body.toString('base64')),
        ))
        first.close()

        const reordered = makeStore([
            roots.active,
            roots.duplicate,
            roots.bundle,
            roots.gzip,
            roots.loose,
        ])
        stores.push(reordered)
        await reordered.normalizeChatBackups()
        expect(await bodyToId(reordered)).toEqual(firstMapping)
        reordered.close()

        const offlinePath = `${roots.gzip}-offline`
        fs.renameSync(roots.gzip, offlinePath)
        const offline = makeStore([
            roots.active,
            roots.loose,
            roots.gzip,
            roots.bundle,
            roots.duplicate,
        ])
        stores.push(offline)
        await offline.normalizeChatBackups()
        const offlineMapping = await bodyToId(offline)
        expect(offlineMapping.get(bodies.active.toString('base64')))
            .toBe(firstMapping.get(bodies.active.toString('base64')))
        expect(offlineMapping.get(bodies.loose.toString('base64')))
            .toBe(firstMapping.get(bodies.loose.toString('base64')))
        expect(offlineMapping.get(bodies.bundle.toString('base64')))
            .toBe(firstMapping.get(bodies.bundle.toString('base64')))
        offline.close()

        fs.renameSync(offlinePath, roots.gzip)
        const restored = makeStore(Object.values(roots))
        stores.push(restored)
        await restored.normalizeChatBackups()
        expect(await bodyToId(restored)).toEqual(firstMapping)
    })

    it('does not apply active-root retention to the only copy left in a historical root', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-root-retention-'))
        tempRoots.push(appRoot)
        const historicalRoot = path.join(appRoot, 'history-a')
        const activeRoot = path.join(appRoot, 'history-b')
        const historicalDir = path.join(historicalRoot, 'old-char', 'old-chat')
        const activeDir = path.join(activeRoot, 'active-char', 'active-chat')
        const onlyHistorical = rawChat(209, 'only historical recovery point')
        fs.mkdirSync(historicalDir, { recursive: true })
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(path.join(historicalDir, 'v-50000-0-historical.bin'), onlyHistorical)
        fs.writeFileSync(path.join(activeDir, 'v-50001-0-active.bin'), rawChat(210, 'active one'))
        fs.writeFileSync(path.join(activeDir, 'v-50002-0-active.bin'), rawChat(211, 'active two'))

        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            getByteBudget: () => 1,
            byteBudgetMin: 1,
            getUncompressedByteBudget: () => 1024 * 1024,
            uncompressedByteBudgetMin: 1,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        const result = await store.reconcileChatBackups()

        expect(result.budgetItemsRemoved).toBe(1)
        expect(fs.existsSync(path.join(historicalDir, 'v-50000-0-historical.bin'))).toBe(true)
        const [historicalVersion] = store.listChatBackups('old-char', 'old-chat')
        expect(historicalVersion).toBeDefined()
        expect(await store.readChatBackup('old-char', 'old-chat', historicalVersion.versionId))
            .toEqual(onlyHistorical)
    })
})

describe('chat backup reachability scan', () => {
    it('visits loose, gzip, frame, bundle, and federated-root versions', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-history-scan-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const historicalRoot = path.join(appRoot, 'historical')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const historicalDir = path.join(historicalRoot, 'char', 'chat')
        fs.mkdirSync(activeDir, { recursive: true })
        fs.mkdirSync(historicalDir, { recursive: true })

        const fixtures = [
            { versionId: 'v-51000-0-loose', raw: rawChat(510, 'loose') },
            { versionId: 'v-51001-0-gzip', raw: rawChat(511, 'gzip') },
            { versionId: 'v-51002-0-frame', raw: rawChat(512, 'frame') },
            { versionId: 'v-51003-0-bundle', raw: rawChat(513, 'bundle') },
            { versionId: 'v-51004-0-federated', raw: rawChat(514, 'federated') },
        ]
        fs.writeFileSync(
            path.join(activeDir, `${fixtures[0].versionId}.bin`),
            fixtures[0].raw,
        )
        fs.writeFileSync(
            path.join(activeDir, `${fixtures[1].versionId}.bin.gz`),
            zlib.gzipSync(fixtures[1].raw),
        )
        writeFrameFixture(activeDir, fixtures[2].versionId, fixtures[2].raw)
        writeLegacySolidBundle(activeDir, [fixtures[3]])
        fs.writeFileSync(
            path.join(historicalDir, `${fixtures[4].versionId}.bin`),
            fixtures[4].raw,
        )

        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [activeRoot, historicalRoot],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        const observed: Array<{
            text: string
            versionId: string
            sourceVersionId: string
            storage: string
            rootIdentity: string
        }> = []
        const result = await store.scanChatBackupVersions(async (raw, identity) => {
            const chat = await decodeRisuSave(raw)
            observed.push({
                text: chat.message[0].data,
                versionId: identity.versionId,
                sourceVersionId: identity.sourceVersionId,
                storage: identity.storage,
                rootIdentity: identity.rootIdentity,
            })
        })

        expect(result.totalVersions).toBe(5)
        expect(observed.map(item => item.sourceVersionId).sort())
            .toEqual(fixtures.map(item => item.versionId).sort())
        expect(new Set(observed.map(item => item.storage))).toEqual(new Set([
            'loose',
            'loose-gzip',
            'frame',
            'legacy-bundle',
        ]))
        expect(new Set(observed.map(item => item.rootIdentity)).size).toBe(2)
        expect(observed.map(item => item.text)).toEqual(expect.arrayContaining(
            fixtures.map((item, index) => `message-${510 + index}-${item.versionId.split('-').at(-1)}`),
        ))
    })

    it('fails closed when a retained version becomes unreadable', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-history-unreadable-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(
            path.join(activeDir, 'v-52000-0-corrupt.bin.gz'),
            Buffer.from('not gzip data'),
        )
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        await expect(store.scanChatBackupVersions(() => {}))
            .rejects.toThrow('Cannot verify retained chat backup char/chat/v-52000-0-corrupt')
    })

    it('fails closed when a physical chat directory cannot be inventoried', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-history-dir-error-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(path.join(activeDir, 'v-52100-0-readable.bin'), rawChat(521))
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        const realReaddir = fs.readdirSync.bind(fs)
        const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((directory, options) => {
            if (path.resolve(String(directory)) === path.resolve(activeDir)) {
                throw Object.assign(new Error('injected chat-directory read failure'), {
                    code: 'EACCES',
                })
            }
            return realReaddir(directory, options as never)
        }) as typeof fs.readdirSync)
        try {
            await expect(store.scanChatBackupVersions(() => {}))
                .rejects.toThrow(`Cannot verify retained chat-backup directory ${activeDir}`)
        } finally {
            spy.mockRestore()
        }
    })

    it('fails closed for recognized malformed frame and bundle metadata', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-history-invalid-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        fs.mkdirSync(activeDir, { recursive: true })
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        const framePath = path.join(activeDir, 'v-52200-0-malformed.frame')
        fs.writeFileSync(framePath, Buffer.from('not a frame'))
        await expect(store.scanChatBackupVersions(() => {}))
            .rejects.toThrow(`Cannot verify retained chat-backup frame ${framePath}`)
        fs.unlinkSync(framePath)

        const bundlePath = path.join(activeDir, 'archive-52201-52201.bundle')
        const metaPath = bundlePath.replace(/\.bundle$/, '.meta.json')
        fs.writeFileSync(bundlePath, zlib.gzipSync(rawChat(522)))
        fs.writeFileSync(metaPath, '{"format":"broken","entries":')
        await expect(store.scanChatBackupVersions(() => {}))
            .rejects.toThrow(`Cannot verify retained chat-backup bundle metadata ${metaPath}`)
    })

    it('fails closed when an inventoried candidate disappears before its read', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-history-race-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const activeDir = path.join(activeRoot, 'char', 'chat')
        const versionPath = path.join(activeDir, 'v-52300-0-disappears.bin')
        fs.mkdirSync(activeDir, { recursive: true })
        fs.writeFileSync(versionPath, rawChat(523))
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
            diagnostics: {
                onEvent(event: Record<string, unknown>) {
                    if (event.event === 'reachability-inventory-complete') {
                        fs.unlinkSync(versionPath)
                    }
                },
            },
        }) as ChatBackupStore
        stores.push(store)

        await expect(store.scanChatBackupVersions(() => {}))
            .rejects.toThrow('Cannot verify retained chat backup char/chat/v-52300-0-disappears')
    })

    it('fails closed when a required historical root is unavailable', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-history-offline-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const historicalRoot = path.join(appRoot, 'historical')
        fs.mkdirSync(activeRoot, { recursive: true })
        fs.mkdirSync(historicalRoot, { recursive: true })
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            getChatBackupsReadRoots: () => [{ root: historicalRoot, required: true }],
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)
        fs.renameSync(historicalRoot, `${historicalRoot}-offline`)

        await expect(store.scanChatBackupVersions(() => {}))
            .rejects.toThrow(`Cannot verify retained chat-backup root ${historicalRoot}`)
    })

    it('strictly discovers protected conflict containers without changing permissive listing', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-conflict-container-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const conflictRoot = path.join(activeRoot, '%2Eroot-history')
        const protectedDir = path.join(conflictRoot, 'protected', 'char', 'chat')
        fs.mkdirSync(protectedDir, { recursive: true })
        fs.writeFileSync(
            path.join(protectedDir, 'v-52400-0-protected.bin'),
            rawChat(524, '{{inlay::protected-conflict}}'),
        )
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        const realReaddir = fs.readdirSync.bind(fs)
        const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((directory, options) => {
            if (path.resolve(String(directory)) === path.resolve(conflictRoot)) {
                throw Object.assign(new Error('injected protected-container failure'), {
                    code: 'EACCES',
                })
            }
            return realReaddir(directory, options as never)
        }) as typeof fs.readdirSync)
        try {
            expect(store.listChatBackupChats()).toEqual([])
            await expect(store.scanChatBackupVersions(() => {}))
                .rejects.toThrow(`Cannot verify protected chat-backup container ${conflictRoot}`)
        } finally {
            spy.mockRestore()
        }
    })

    it('fails closed when a discovered protected conflict root disappears before inventory', async () => {
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-conflict-race-'))
        tempRoots.push(appRoot)
        const activeRoot = path.join(appRoot, 'active')
        const protectedRoot = path.join(activeRoot, '%2Eroot-history', 'protected')
        const protectedDir = path.join(protectedRoot, 'char', 'chat')
        fs.mkdirSync(protectedDir, { recursive: true })
        fs.writeFileSync(
            path.join(protectedDir, 'v-52500-0-protected.bin'),
            rawChat(525, '{{inlay::protected-race}}'),
        )
        const store = createChatBackupStore({
            getChatBackupsRoot: () => activeRoot,
            readChatRowRaw: () => null,
            autoReconcile: false,
            diagnostics: {
                onEvent(event: Record<string, unknown>) {
                    if (event.event === 'reachability-roots-discovered') {
                        fs.rmSync(protectedRoot, { recursive: true, force: true })
                    }
                },
            },
        }) as ChatBackupStore
        stores.push(store)

        await expect(store.scanChatBackupVersions(() => {}))
            .rejects.toThrow(`Cannot verify retained chat-backup root ${protectedRoot}`)
    })
})

describe('chat backup capture', () => {
    it('streams an exact loose pre-image without materializing the protected row', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chat-backups-stream-'))
        tempRoots.push(root)
        const expected = rawChat(1, 'x'.repeat(12_000))
        const materializedRead = vi.fn(() => {
            throw new Error('the production stream path must not read the full row')
        })
        let streamedParts = 0
        let maxPartBytes = 0
        const store = createChatBackupStore({
            getChatBackupsRoot: () => path.join(root, 'chat-backups'),
            readChatRowRaw: materializedRead,
            inspectChatRow: () => ({ size: expected.length, coldStorage: false }),
            streamChatRowRawToFile: async (
                _chaId: string,
                _chatId: string,
                filePath: string,
            ) => {
                const fd = fs.openSync(filePath, 'wx')
                try {
                    for (let offset = 0; offset < expected.length; offset += 257) {
                        const part = expected.subarray(offset, Math.min(expected.length, offset + 257))
                        fs.writeSync(fd, part)
                        streamedParts++
                        maxPartBytes = Math.max(maxPartBytes, part.length)
                    }
                } finally {
                    fs.closeSync(fd)
                }
                return {
                    filePath,
                    size: expected.length,
                    chunks: streamedParts,
                    maxChunkBytes: maxPartBytes,
                }
            },
            now: () => 123_456,
            cooldownMs: 0,
            getByteBudget: () => 100 * 1024 * 1024,
            byteBudgetMin: 1,
            autoReconcile: false,
        })
        stores.push(store)

        expect(await store.captureChatPreImage({ chaId: 'char', chatId: 'chat' }))
            .toBe('captured')
        const [version] = store.listChatBackups('char', 'chat')
        expect(await store.readChatBackup('char', 'chat', version.versionId)).toEqual(expected)
        expect(materializedRead).not.toHaveBeenCalled()
        expect(streamedParts).toBeGreaterThan(1)
        expect(maxPartBytes).toBeLessThanOrEqual(257)
    })

    it('skips a new chat and copies each old row before it is overwritten', async () => {
        const harness = makeHarness()
        const { store } = harness

        expect(await store.captureChatPreImage({
            chaId: 'char',
            chatId: 'missing',
            reason: 'save',
        })).toBe('skipped-no-row')

        const oldFirst = rawChat(1)
        const incomingFirst = rawChat(2)
        const incomingSecond = rawChat(3)
        harness.setRow('char', 'chat', oldFirst)

        expect(await store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'edit',
        })).toBe('captured')
        harness.setRow('char', 'chat', incomingFirst)
        harness.advance()
        expect(await store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'edit',
        })).toBe('captured')
        harness.setRow('char', 'chat', incomingSecond)

        const versions = store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        expect((await store.readChatBackup('char', 'chat', versions[1].versionId))?.equals(oldFirst))
            .toBe(true)
        expect((await store.readChatBackup('char', 'chat', versions[0].versionId))?.equals(incomingFirst))
            .toBe(true)
        expect((await store.readChatBackup('char', 'chat', versions[0].versionId))?.equals(incomingSecond))
            .toBe(false)
    })

    it('keeps the older pre-image during cooldown and captures after it expires', async () => {
        const harness = makeHarness({ cooldownMs: 45_000 })
        const first = rawChat(1)
        const second = rawChat(2)
        harness.setRow('char', 'chat', first)

        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).toBe('captured')
        harness.setRow('char', 'chat', second)
        harness.advance(44_999)
        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).toBe('skipped-cooldown')

        expect(harness.store.listChatBackups('char', 'chat')).toHaveLength(1)
        harness.advance(1)
        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).toBe('captured')
        expect(harness.store.listChatBackups('char', 'chat')).toHaveLength(2)
    })

    it('captures after an in-process wall-clock rollback', async () => {
        const harness = makeHarness({ now: 500_000, cooldownMs: 45_000 })
        const beforeRollback = rawChat(10, 'before rollback')
        const afterRollback = rawChat(11, 'after rollback')
        harness.setRow('char', 'chat', beforeRollback)

        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })).toBe('captured')
        harness.setRow('char', 'chat', afterRollback)
        harness.setNow(499_999)

        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })).toBe('captured')
        const versions = harness.store.listChatBackups('char', 'chat')
        expect(versions.map(version => version.versionId)).toEqual([
            'v-500000-0-save',
            'v-499999-0-save',
        ])
        expect((await harness.store.readChatBackup(
            'char',
            'chat',
            'v-499999-0-save',
        ))?.equals(afterRollback)).toBe(true)
    })

    it('forces a deletion pre-image through cooldown and cold-storage filtering', async () => {
        const harness = makeHarness({ cooldownMs: 45_000 })
        const first = rawChat(1)
        const coldStub = Buffer.from(encodeRisuSaveLegacy({
            id: 'cold',
            message: [{ data: `${COLD_STORAGE_HEADER}coldstorage/key` }],
        }))
        harness.setRow('char', 'chat', first)

        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).toBe('captured')
        harness.setRow('char', 'chat', coldStub)
        harness.advance(1)

        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'delete-chat',
            force: true,
            required: true,
        })).toBe('captured')
        const versions = harness.store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        expect(versions[0].reason).toBe('delete-chat')
        expect((await harness.store.readChatBackup('char', 'chat', versions[0].versionId))?.equals(coldStub))
            .toBe(true)
    })

    it('seeds cooldown from disk after a store restart', async () => {
        const harness = makeHarness({ now: 5_000, cooldownMs: 45_000 })
        harness.setRow('char', 'chat', rawChat(1))
        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).toBe('captured')
        harness.store.close()

        const restarted = createChatBackupStore({
            getChatBackupsRoot: () => path.join(harness.root, 'chat-backups'),
            readChatRowRaw: (chaId: string, chatId: string) => (
                harness.rows.get(rowKey(chaId, chatId)) ?? null
            ),
            now: () => 5_001,
            cooldownMs: 45_000,
            getByteBudget: () => 100 * 1024 * 1024,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(restarted)

        expect(await restarted.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).toBe('skipped-cooldown')
        expect(restarted.listChatBackups('char', 'chat')).toHaveLength(1)
    })

    it('recovers from a future disk timestamp and resets the cooldown baseline', async () => {
        const harness = makeHarness({ now: 200_000, cooldownMs: 45_000 })
        const futurePreImage = rawChat(20, 'future timestamp')
        const rollbackPreImage = rawChat(21, 'rollback recovery point')
        const expiryPreImage = rawChat(22, 'expiry boundary')
        harness.setRow('char', 'chat', futurePreImage)
        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })).toBe('captured')
        harness.store.close()

        harness.setRow('char', 'chat', rollbackPreImage)
        let restartedClock = 100_000
        const restarted = createChatBackupStore({
            getChatBackupsRoot: () => path.join(harness.root, 'chat-backups'),
            readChatRowRaw: (chaId: string, chatId: string) => (
                harness.rows.get(rowKey(chaId, chatId)) ?? null
            ),
            now: () => restartedClock,
            cooldownMs: 45_000,
            getByteBudget: () => 100 * 1024 * 1024,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(restarted)

        expect(await restarted.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })).toBe('captured')
        expect(restarted.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual([
                'v-200000-0-save',
                'v-100000-0-save',
            ])
        expect((await restarted.readChatBackup(
            'char',
            'chat',
            'v-200000-0-save',
        ))?.equals(futurePreImage)).toBe(true)
        expect((await restarted.readChatBackup(
            'char',
            'chat',
            'v-100000-0-save',
        ))?.equals(rollbackPreImage)).toBe(true)

        harness.setRow('char', 'chat', expiryPreImage)
        expect(await restarted.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })).toBe('skipped-cooldown')
        restartedClock = 144_999
        expect(await restarted.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })).toBe('skipped-cooldown')
        restartedClock = 145_000
        expect(await restarted.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })).toBe('captured')
        expect((await restarted.readChatBackup(
            'char',
            'chat',
            'v-145000-0-save',
        ))?.equals(expiryPreImage)).toBe(true)
    })

    it('sanitizes reasons, defaults empty reasons, and increments seq on timestamp collisions', async () => {
        const harness = makeHarness({ now: 123_456 })
        harness.setRow('char', 'chat', rawChat(1))

        expect(sanitizeBackupReason(' Manual SAVE!! ../../ ')).toBe('manual-save')
        expect(sanitizeBackupReason(undefined)).toBe('unknown')

        await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: ' Manual SAVE!! ../../ ',
        })
        await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: '',
        })

        expect(fs.readdirSync(chatDir(harness.root, 'char', 'chat')).sort()).toEqual([
            'v-123456-0-manual-save.bin',
            'v-123456-1-unknown.bin',
        ])
    })

    it('classifies only sanitized destructive row-overwrite reasons', () => {
        expect(isDestructiveBackupReason('reroll')).toBe(true)
        expect(isDestructiveBackupReason(' DELETE MESSAGE!! ')).toBe(true)
        expect(isDestructiveBackupReason('Delete Swipe')).toBe(true)
        expect(isDestructiveBackupReason('script-bulk-chat')).toBe(true)
        expect(isDestructiveBackupReason('edit-message')).toBe(false)
        expect(isDestructiveBackupReason('delete-chat')).toBe(false)
        expect(isDestructiveBackupReason(undefined)).toBe(false)
    })

    it('skips small cold-storage stubs and never decodes large rows', async () => {
        const decodeSpy = vi.fn((raw: Buffer) => decodeRisuSave(raw))
        const harness = makeHarness({ decodeChat: decodeSpy })
        const coldStub = Buffer.from(encodeRisuSaveLegacy({
            id: 'cold',
            message: [{ data: `${COLD_STORAGE_HEADER}coldstorage/key` }],
        }))
        harness.setRow('char', 'cold', coldStub)

        expect(coldStub.length).toBeLessThan(4096)
        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'cold',
        })).toBe('skipped-cold-storage')
        expect(decodeSpy).toHaveBeenCalledTimes(1)

        const large = Buffer.alloc(4096, 0xab)
        harness.setRow('char', 'large', large)
        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'large',
        })).toBe('captured')
        expect(decodeSpy).toHaveBeenCalledTimes(1)
        const [version] = harness.store.listChatBackups('char', 'large')
        expect((await harness.store.readChatBackup('char', 'large', version.versionId))?.equals(large))
            .toBe(true)
    })

    it('contains read and filesystem errors instead of throwing into a save', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chat-backups-error-'))
        tempRoots.push(root)
        const logger = { error: vi.fn(), warn: vi.fn() }
        const store = createChatBackupStore({
            getChatBackupsRoot: () => path.join(root, 'chat-backups'),
            readChatRowRaw: () => {
                throw new Error('row read failed')
            },
            logger,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        await expect(store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).resolves.toBe('error')
        expect(logger.error).toHaveBeenCalled()
    })

    it('rejects capture failures when the caller requires a recovery copy', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chat-backups-required-'))
        tempRoots.push(root)
        const store = createChatBackupStore({
            getChatBackupsRoot: () => path.join(root, 'chat-backups'),
            readChatRowRaw: () => {
                throw new Error('required row read failed')
            },
            logger: { error: vi.fn(), warn: vi.fn() },
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        await expect(store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            force: true,
            required: true,
        })).rejects.toThrow('required row read failed')
    })
})

describe('chat backup reconcile and reads', () => {
    it('streams independently compressed self-describing frames and is idempotent', async () => {
        const harness = makeHarness()
        const expected = rawChat(1, 'x'.repeat(256_000))
        harness.setRow('char', 'chat', expected)
        await harness.store.captureChatPreImage({ chaId: 'char', chatId: 'chat', reason: 'save' })

        const tree = path.join(harness.root, 'chat-backups')
        const staleDir = path.join(tree, 'stale-char', 'stale-chat')
        const emptyDir = path.join(tree, 'empty-char', 'empty-chat')
        fs.mkdirSync(staleDir, { recursive: true })
        fs.mkdirSync(emptyDir, { recursive: true })
        fs.writeFileSync(path.join(staleDir, 'interrupted.frame.tmp'), 'partial')

        const first = await harness.store.reconcileChatBackups()
        expect(first).toMatchObject({ staleTempsRemoved: 1, gzipped: 1, framesCreated: 1 })
        const directory = chatDir(harness.root, 'char', 'chat')
        const names = fs.readdirSync(directory)
        expect(names).toEqual(['v-1000000-0-save.frame'])
        const frame = readFrameFixture(path.join(directory, names[0]))
        expect(frame.header).toMatchObject({
            format: FRAME_FORMAT,
            contentType: 'application/vnd.pocketrisu.chat-row',
            compression: 'gzip',
            uncompressedSize: expected.length,
            versionId: 'v-1000000-0-save',
            timestamp: 1_000_000,
            sequence: 0,
            reason: 'save',
        })
        expect(zlib.gunzipSync(frame.payload)).toEqual(expected)
        expect(await harness.store.readChatBackup('char', 'chat', frame.header.versionId))
            .toEqual(expected)
        expect(fs.existsSync(path.join(tree, 'stale-char'))).toBe(false)
        expect(fs.existsSync(path.join(tree, 'empty-char'))).toBe(false)

        const source = fs.readFileSync(path.join(process.cwd(), 'server/node/chatBackups.cjs'), 'utf-8')
        expect(source).not.toContain('gzipSync')
        expect(source).not.toContain('gunzipSync')
        expect(source).not.toContain('Buffer.concat(rawEntries)')

        const snapshot = recursiveSnapshot(tree)
        expect(await harness.store.reconcileChatBackups()).toMatchObject({
            staleTempsRemoved: 0,
            gzipped: 0,
            framesCreated: 0,
            budgetItemsRemoved: 0,
        })
        expect(recursiveSnapshot(tree)).toEqual(snapshot)
    })

    it('reads the selected representation when divergent same-ID files are co-located', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chat-backups-colocated-'))
        tempRoots.push(root)
        const directory = path.join(root, 'char', 'chat')
        const versionId = 'v-55000-0-colocated'
        const framed = rawChat(219, 'framed representation')
        const loose = rawChat(220, 'loose representation')
        writeFrameFixture(directory, versionId, framed)
        fs.writeFileSync(path.join(directory, `${versionId}.bin`), loose)
        const store = createChatBackupStore({
            getChatBackupsRoot: () => root,
            readChatRowRaw: () => null,
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        const versions = store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        const selectedBodies = await Promise.all(versions.map(version => (
            store.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(selectedBodies.map(body => body?.toString('base64')))).toEqual(new Set([
            framed.toString('base64'),
            loose.toString('base64'),
        ]))

        await store.normalizeChatBackups()
        const normalizedVersions = store.listChatBackups('char', 'chat')
        expect(normalizedVersions).toHaveLength(2)
        expect(new Set(await Promise.all(normalizedVersions.map(async version => (
            (await store.readChatBackup('char', 'chat', version.versionId))?.toString('base64')
        ))))).toEqual(new Set([
            framed.toString('base64'),
            loose.toString('base64'),
        ]))
    })

    it('keeps co-located divergent representations independently readable after normalization fails', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chat-normalize-failure-'))
        tempRoots.push(root)
        const directory = path.join(root, 'char', 'chat')
        const versionId = 'v-55100-0-normalize-failure'
        const framed = rawChat(224, 'frame survives normalize failure')
        const loose = rawChat(225, 'loose survives normalize failure')
        const loosePath = path.join(directory, `${versionId}.bin`)
        writeFrameFixture(directory, versionId, framed)
        fs.writeFileSync(loosePath, loose)
        const store = createChatBackupStore({
            getChatBackupsRoot: () => root,
            readChatRowRaw: () => null,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            autoReconcile: false,
        }) as ChatBackupStore
        stores.push(store)

        const realLink = fs.linkSync.bind(fs)
        const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
            if (String(destination).includes('%2Eroot-history')) {
                throw Object.assign(new Error('injected normalization publication failure'), {
                    code: 'EIO',
                })
            }
            return realLink(source, destination)
        })
        let normalized
        try {
            normalized = await store.normalizeChatBackups()
        } finally {
            linkSpy.mockRestore()
        }

        expect(normalized).toMatchObject({
            looseVersionsConverted: 0,
            framesCreated: 0,
        })
        expect(fs.readFileSync(loosePath)).toEqual(loose)
        const versions = store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(2)
        const bodies = await Promise.all(versions.map(version => (
            store.readChatBackup('char', 'chat', version.versionId)
        )))
        expect(new Set(bodies.map(body => body?.toString('base64')))).toEqual(new Set([
            framed.toString('base64'),
            loose.toString('base64'),
        ]))
    })

    it('decompresses only the requested frame for a single-version read', async () => {
        const events: Array<Record<string, any>> = []
        const harness = makeHarness({
            now: 10_000,
            diagnostics: { onEvent: event => events.push(event) },
        })
        const expected = new Map<string, Buffer>()
        for (let index = 0; index < 3; index++) {
            const raw = rawChat(index, String(index).repeat(80_000))
            harness.setRow('char', 'chat', raw)
            await harness.store.captureChatPreImage({ chaId: 'char', chatId: 'chat', reason: 'read' })
            expected.set(`v-${10_000 + index}-0-read`, raw)
            harness.advance()
        }
        await harness.store.reconcileChatBackups()

        events.length = 0
        const requested = 'v-10001-0-read'
        expect(await harness.store.readChatBackup('char', 'chat', requested))
            .toEqual(expected.get(requested))
        const starts = events.filter(event => event.event === 'decompress-start')
        expect(starts).toEqual([expect.objectContaining({
            operation: 'read',
            versionId: requested,
            storage: 'frame',
            frameFile: `${requested}.frame`,
        })])
        expect(events.filter(event => event.event === 'uncompressed-state')
            .map(event => event.bufferedFrames)).toEqual([1, 0])
    })

    it.each([
        {
            state: 'a non-frame garbage derivative',
            derivative: () => Buffer.from('corrupt derivative'),
        },
        {
            state: 'a valid magic with a garbage header',
            derivative: () => Buffer.concat([
                Buffer.from('PRCHATF1', 'ascii'),
                Buffer.from('garbage header and lengths'),
            ]),
        },
        {
            state: 'an empty rename-published frame',
            derivative: () => Buffer.alloc(0),
        },
    ])('regenerates $state before deleting its exact raw source', async ({ derivative }) => {
        const harness = makeHarness()
        const expected = rawChat(70)
        harness.setRow('char', 'chat', expected)
        await harness.store.captureChatPreImage({ chaId: 'char', chatId: 'chat', reason: 'save' })
        const directory = chatDir(harness.root, 'char', 'chat')
        const rawFilename = fs.readdirSync(directory).find(name => name.endsWith('.bin')) as string
        const versionId = rawFilename.slice(0, -4)
        fs.writeFileSync(path.join(directory, `${versionId}.frame`), derivative())

        await harness.store.reconcileChatBackups()

        expect(fs.existsSync(path.join(directory, rawFilename))).toBe(false)
        expect(await harness.store.readChatBackup('char', 'chat', versionId)).toEqual(expected)
    })

    it('enforces the count cap by deleting one oldest frame without decompression', async () => {
        const events: Array<Record<string, any>> = []
        const harness = makeHarness({
            now: 20_000,
            maxVersionsPerChat: 3,
            diagnostics: { onEvent: event => events.push(event) },
        })
        for (let index = 0; index < 4; index++) {
            harness.setRow('char', 'chat', rawChat(index))
            await harness.store.captureChatPreImage({ chaId: 'char', chatId: 'chat', reason: 'cap' })
            harness.advance()
        }

        const result = await harness.store.reconcileChatBackups()
        expect(result.versionsTrimmed).toBe(1)
        expect(harness.store.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual(['v-20003-0-cap', 'v-20002-0-cap', 'v-20001-0-cap'])
        expect(await harness.store.readChatBackup('char', 'chat', 'v-20000-0-cap')).toBeNull()
        expect(events.some(event => event.event === 'version-delete'
            && event.versionId === 'v-20000-0-cap')).toBe(true)
        const deleteIndex = events.findIndex(event => event.event === 'version-delete')
        expect(events.slice(deleteIndex).some(event => event.event === 'decompress-start')).toBe(false)
    })

    it('enforces the configurable per-chat uncompressed-byte cap oldest first', async () => {
        const raws = [rawChat(1, 'a'.repeat(5_000)), rawChat(2, 'b'.repeat(6_000)), rawChat(3, 'c'.repeat(7_000))]
        const harness = makeHarness({ now: 30_000 })
        harness.setMaxUncompressedBytes(raws[1].length + raws[2].length)
        for (const raw of raws) {
            harness.setRow('char', 'chat', raw)
            await harness.store.captureChatPreImage({ chaId: 'char', chatId: 'chat', reason: 'bytes' })
            harness.advance()
        }

        const result = await harness.store.reconcileChatBackups()
        expect(result.uncompressedVersionsTrimmed).toBe(1)
        expect(result.totalUncompressedBytes).toBeLessThanOrEqual(result.maxUncompressedBytes)
        expect(harness.store.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual(['v-30002-0-bytes', 'v-30001-0-bytes'])
        expect(await harness.store.readChatBackup('char', 'chat', 'v-30000-0-bytes')).toBeNull()
        expect(await harness.store.readChatBackup('char', 'chat', 'v-30001-0-bytes'))
            .toEqual(raws[1])
    })

    it('lists, reads, and crash-safely migrates a byte-exact old solid bundle', async () => {
        const events: Array<Record<string, any>> = []
        const harness = makeHarness({ diagnostics: { onEvent: event => events.push(event) } })
        const directory = chatDir(harness.root, 'legacy-char', 'legacy-chat')
        fs.mkdirSync(directory, { recursive: true })
        const fixtures = [0, 1, 2].map(index => ({
            versionId: `v-${40_000 + index}-0-legacy`,
            raw: rawChat(400 + index, String(index).repeat(100_000)),
        }))
        const legacy = writeLegacySolidBundle(directory, fixtures)

        expect(harness.store.listChatBackups('legacy-char', 'legacy-chat')).toEqual(
            [...fixtures].reverse().map(({ versionId, raw }) => ({
                versionId,
                ts: Number(/^v-(\d+)-/.exec(versionId)?.[1]),
                reason: 'legacy',
                size: raw.length,
                storage: 'bundle',
                bundleFile: legacy.bundleFile,
            })),
        )
        for (const fixture of fixtures) {
            expect(await harness.store.readChatBackup(
                'legacy-char',
                'legacy-chat',
                fixture.versionId,
            )).toEqual(fixture.raw)
        }

        events.length = 0
        const result = await harness.store.reconcileChatBackups()
        expect(result.legacyBundlesMigrated).toBe(1)
        expect(fs.existsSync(legacy.bundlePath)).toBe(false)
        expect(fs.existsSync(legacy.bundlePath.replace(/\.bundle$/, '.meta.json'))).toBe(false)
        expect(fs.readdirSync(directory).sort()).toEqual(
            fixtures.map(({ versionId }) => `${versionId}.frame`).sort(),
        )
        expect(Math.max(...events
            .filter(event => event.event === 'uncompressed-chunk')
            .map(event => event.bufferedFrames))).toBeLessThanOrEqual(1)
        for (const fixture of fixtures) {
            expect(await harness.store.readChatBackup(
                'legacy-char',
                'legacy-chat',
                fixture.versionId,
            )).toEqual(fixture.raw)
        }
    })

    it('keeps every legacy version restorable when bundle withdrawal is interrupted', async () => {
        const harness = makeHarness()
        const directory = chatDir(harness.root, 'legacy-char', 'legacy-chat')
        fs.mkdirSync(directory, { recursive: true })
        const fixtures = [0, 1].map(index => ({
            versionId: `v-${50_000 + index}-0-failure`,
            raw: rawChat(500 + index),
        }))
        const legacy = writeLegacySolidBundle(directory, fixtures)
        const unlinkSync = fs.unlinkSync.bind(fs)
        let rejectedWithdrawal = false
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            if (!rejectedWithdrawal && String(filename).endsWith('.meta.json')) {
                rejectedWithdrawal = true
                throw Object.assign(new Error('injected withdrawal failure'), { code: 'EIO' })
            }
            return unlinkSync(filename)
        })
        await harness.store.reconcileChatBackups().finally(() => unlinkSpy.mockRestore())

        expect(rejectedWithdrawal).toBe(true)
        expect(fs.existsSync(legacy.bundlePath)).toBe(true)
        expect(fs.existsSync(legacy.bundlePath.replace(/\.bundle$/, '.meta.json'))).toBe(true)
        for (const fixture of fixtures) {
            expect(await harness.store.readChatBackup(
                'legacy-char',
                'legacy-chat',
                fixture.versionId,
            )).toEqual(fixture.raw)
        }

        expect((await harness.store.reconcileChatBackups()).legacyBundlesMigrated).toBe(1)
        expect(fs.readdirSync(directory).every(name => name.endsWith('.frame'))).toBe(true)
    })

    it('retains the exact default 125-version count and evicts only the oldest overflow', async () => {
        const harness = makeHarness({ now: 60_000 })
        for (let index = 0; index < 126; index++) {
            harness.setRow('char', 'chat', rawChat(index))
            await harness.store.captureChatPreImage({ chaId: 'char', chatId: 'chat', reason: 'default' })
            harness.advance()
        }

        const result = await harness.store.reconcileChatBackups()
        const versions = harness.store.listChatBackups('char', 'chat')
        expect(result.versionsTrimmed).toBe(1)
        expect(versions).toHaveLength(125)
        expect(versions[0].versionId).toBe('v-60125-0-default')
        expect(versions.at(-1)?.versionId).toBe('v-60001-0-default')
        expect(await harness.store.readChatBackup('char', 'chat', 'v-60000-0-default')).toBeNull()
    })

    it('enforces the compressed disk budget globally and preserves each chat newest', async () => {
        const harness = makeHarness({ maxBytes: 100 * 1024 * 1024 })
        for (const timestamp of [100, 200, 300]) {
            harness.setNow(timestamp)
            harness.setRow('char-a', 'chat-a', rawChat(timestamp))
            await harness.store.captureChatPreImage({ chaId: 'char-a', chatId: 'chat-a', reason: 'a' })
        }
        for (const timestamp of [150, 250]) {
            harness.setNow(timestamp)
            harness.setRow('char-b', 'chat-b', rawChat(timestamp))
            await harness.store.captureChatPreImage({ chaId: 'char-b', chatId: 'chat-b', reason: 'b' })
        }
        await harness.store.reconcileChatBackups()

        harness.setMaxBytes(1)
        const result = await harness.store.reconcileChatBackups()
        expect(result.totalBytes).toBeGreaterThan(result.maxBytes)
        expect(harness.store.listChatBackups('char-a', 'chat-a').map(version => version.ts))
            .toEqual([300])
        expect(harness.store.listChatBackups('char-b', 'chat-b').map(version => version.ts))
            .toEqual([250])
        expect(await harness.store.readChatBackup('char-a', 'chat-a', 'v-300-0-a')).not.toBeNull()
        expect(await harness.store.readChatBackup('char-b', 'chat-b', 'v-250-0-b')).not.toBeNull()
    })
})

describe('chat backup listing', () => {
    it('orders and summarizes framed versions without decompressing payloads', async () => {
        const events: Array<Record<string, any>> = []
        const harness = makeHarness({
            now: 70_000,
            diagnostics: { onEvent: event => events.push(event) },
        })
        const expectedSizes = new Map<number, number>()
        for (let index = 0; index < 27; index++) {
            const raw = rawChat(index)
            expectedSizes.set(70_000 + index, raw.length)
            harness.setRow('char/雪', 'chat%one', raw)
            await harness.store.captureChatPreImage({
                chaId: 'char/雪',
                chatId: 'chat%one',
                reason: 'frame',
            })
            harness.advance()
        }
        await harness.store.reconcileChatBackups()
        events.length = 0
        const versions = harness.store.listChatBackups('char/雪', 'chat%one')
        expect(versions).toHaveLength(27)
        expect(versions.map(version => version.ts)).toEqual(
            Array.from({ length: 27 }, (_, index) => 70_026 - index),
        )
        expect(versions.every(version => (
            version.storage === 'bundle'
            && version.bundleFile === `${version.versionId}.frame`
        ))).toBe(true)
        for (const version of versions) {
            expect(version.size).toBe(expectedSizes.get(version.ts))
        }
        expect(events).toEqual([])

        expect(harness.store.listChatBackupChats()).toEqual([{
            chaId: 'char/雪',
            chatId: 'chat%one',
            versionCount: 27,
            newestTs: 70_026,
            oldestTs: 70_000,
            totalBytes: expect.any(Number),
        }])
        expect(harness.store.listChatBackupChats()[0].totalBytes).toBeGreaterThan(0)
    })
})

describe('chat backup byte-budget configuration', () => {
    it('applies default, KV, and env precedence with min/max clamping', () => {
        const values = new Map<string, Buffer>()
        const kvGet = (key: string) => values.get(key) ?? null
        const base = {
            kvGet,
            defaultBytes: 500,
            minBytes: 100,
            maxBytes: 1_000,
        }

        expect(resolveChatBackupMaxBytes({ ...base, env: {} })).toBe(500)
        values.set(CHAT_BACKUP_MAX_BYTES_KEY, Buffer.from('700'))
        expect(resolveChatBackupMaxBytes({ ...base, env: {} })).toBe(700)
        expect(resolveChatBackupMaxBytes({
            ...base,
            env: { POCKETRISU_CHAT_BACKUP_MAX_BYTES: '900' },
        })).toBe(900)
        expect(resolveChatBackupMaxBytes({
            ...base,
            env: { POCKETRISU_CHAT_BACKUP_MAX_BYTES: '5000' },
        })).toBe(1_000)

        values.set(CHAT_BACKUP_MAX_BYTES_KEY, Buffer.from('1'))
        expect(resolveChatBackupMaxBytes({ ...base, env: {} })).toBe(100)
        expect(resolveChatBackupMaxBytes({
            ...base,
            env: { POCKETRISU_CHAT_BACKUP_MAX_BYTES: 'not-a-number' },
        })).toBe(100)
    })

    it('applies KV and env precedence to the uncompressed-byte cap', () => {
        const values = new Map<string, Buffer>()
        const kvGet = (key: string) => values.get(key) ?? null
        const base = {
            kvGet,
            defaultBytes: 500,
            minBytes: 100,
            maxBytes: 1_000,
        }

        expect(resolveChatBackupMaxUncompressedBytes({ ...base, env: {} })).toBe(500)
        values.set(CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_KEY, Buffer.from('700'))
        expect(resolveChatBackupMaxUncompressedBytes({ ...base, env: {} })).toBe(700)
        expect(resolveChatBackupMaxUncompressedBytes({
            ...base,
            env: { POCKETRISU_CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES: '900' },
        })).toBe(900)
        expect(resolveChatBackupMaxUncompressedBytes({
            ...base,
            env: { POCKETRISU_CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES: '5000' },
        })).toBe(1_000)
    })
})
