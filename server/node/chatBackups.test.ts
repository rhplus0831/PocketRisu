import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
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
        moved: number
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

    it('migrates legacy versions with the EXDEV copy fallback before reconcile', async () => {
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
        const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
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
            renameSpy.mockRestore()
        }

        expect(result).toMatchObject({ moved: 1, conflicts: 0, failed: 0 })
        expect(fs.existsSync(legacyRoot)).toBe(false)
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

    it('deduplicates identical destinations but preserves divergent legacy files', () => {
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

        expect(result).toMatchObject({ deduplicated: 1, conflicts: 1, failed: 0 })
        expect(fs.existsSync(path.join(legacyRoot, 'identical.bin'))).toBe(false)
        expect(fs.readFileSync(path.join(legacyRoot, 'conflict.bin'), 'utf-8')).toBe('legacy')
        expect(fs.readFileSync(path.join(destinationRoot, 'conflict.bin'), 'utf-8'))
            .toBe('destination')
        expect(logger.warn).toHaveBeenCalled()
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
