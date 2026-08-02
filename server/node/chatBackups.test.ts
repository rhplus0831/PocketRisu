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
        bundlesCreated: number
        bundlesRotated: number
        versionsTrimmed: number
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
    ) => Buffer | null
    close: () => void
}

const {
    createChatBackupStore,
    migrateLegacyChatBackups,
    resolveChatBackupDir,
    resolveChatBackupMaxBytes,
    sanitizeBackupReason,
    CHAT_BACKUP_MAX_BYTES_KEY,
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
    sanitizeBackupReason: (reason?: unknown) => string
    CHAT_BACKUP_MAX_BYTES_KEY: string
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

interface LooseFixture {
    filename: string
    versionId: string
    ts: number
    raw: Buffer
}

function gzipCapturedRawFiles(directory: string): LooseFixture[] {
    return fs.readdirSync(directory)
        .filter(filename => filename.endsWith('.bin'))
        .map((filename) => {
            const rawPath = path.join(directory, filename)
            const raw = fs.readFileSync(rawPath)
            const compressedFilename = `${filename}.gz`
            fs.writeFileSync(path.join(directory, compressedFilename), zlib.gzipSync(raw))
            fs.unlinkSync(rawPath)
            const versionId = filename.slice(0, -'.bin'.length)
            return {
                filename: compressedFilename,
                versionId,
                ts: Number(/^v-(\d+)-/.exec(versionId)?.[1]),
                raw,
            }
        })
        .sort((a, b) => a.ts - b.ts)
}

function writeCorruptBundleClaim(directory: string, loose: LooseFixture[]) {
    const bundleFile = `archive-${loose[0].ts}-${loose.at(-1)?.ts}.bundle`
    const bundlePath = path.join(directory, bundleFile)
    const corruptBundle = Buffer.from('garbage')
    let offset = 0
    const entries = loose.map((entry) => {
        const metaEntry = {
            versionId: entry.versionId,
            offset,
            size: entry.raw.length,
        }
        offset += entry.raw.length
        return metaEntry
    })
    fs.writeFileSync(bundlePath, corruptBundle)
    fs.writeFileSync(bundlePath.replace(/\.bundle$/, '.meta.json'), `${JSON.stringify({
        format: 'pocketrisu-chat-backup-bundle-v1',
        entryCount: entries.length,
        compressedSize: corruptBundle.length,
        entries,
    })}\n`)
    return bundlePath
}

function makeHarness(options: {
    now?: number
    cooldownMs?: number
    versionsPerBundle?: number
    maxBundlesPerChat?: number
    maxVersionsPerChat?: number
    decodeChat?: (raw: Buffer) => Promise<any>
    maxBytes?: number
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-chat-backups-'))
    tempRoots.push(root)
    const rows = new Map<string, Buffer>()
    let clock = options.now ?? 1_000_000
    let maxBytes = options.maxBytes ?? 100 * 1024 * 1024
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
        byteBudgetMin: 1,
        autoReconcile: false,
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
        expect(replacement.readChatBackup('char', 'chat', before.versionId)?.equals(expected))
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
            expect(store.readChatBackup('hub-char', 'hub-chat', version.versionId)?.equals(expected))
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
        expect(migratedStore.readChatBackup('char', 'chat', legacyVersion.versionId)?.equals(expected))
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
        expect(store.readChatBackup('char', 'chat', version.versionId)).toEqual(expected)
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
        expect(store.readChatBackup('char', 'chat', versions[1].versionId)?.equals(oldFirst))
            .toBe(true)
        expect(store.readChatBackup('char', 'chat', versions[0].versionId)?.equals(incomingFirst))
            .toBe(true)
        expect(store.readChatBackup('char', 'chat', versions[0].versionId)?.equals(incomingSecond))
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
        expect(harness.store.readChatBackup('char', 'chat', versions[0].versionId)?.equals(coldStub))
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
        expect(harness.store.readChatBackup('char', 'large', version.versionId)?.equals(large))
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
    it('gzips loose raws, removes stale temps, prunes empties, and is idempotent', async () => {
        const harness = makeHarness()
        harness.setRow('char', 'chat', rawChat(1))
        await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })

        const tree = path.join(harness.root, 'chat-backups')
        const staleDir = path.join(tree, 'stale-char', 'stale-chat')
        const emptyDir = path.join(tree, 'empty-char', 'empty-chat')
        fs.mkdirSync(staleDir, { recursive: true })
        fs.mkdirSync(emptyDir, { recursive: true })
        fs.writeFileSync(path.join(staleDir, 'interrupted.bundle.tmp'), 'partial')

        const firstResult = await harness.store.reconcileChatBackups()
        expect(firstResult.staleTempsRemoved).toBe(1)
        expect(firstResult.gzipped).toBe(1)
        const names = fs.readdirSync(chatDir(harness.root, 'char', 'chat'))
        expect(names).toHaveLength(1)
        expect(names[0]).toMatch(/\.bin\.gz$/)
        expect(fs.existsSync(path.join(tree, 'stale-char'))).toBe(false)
        expect(fs.existsSync(path.join(tree, 'empty-char'))).toBe(false)

        const snapshot = recursiveSnapshot(tree)
        const secondResult = await harness.store.reconcileChatBackups()
        expect(secondResult.staleTempsRemoved).toBe(0)
        expect(secondResult.gzipped).toBe(0)
        expect(secondResult.bundlesCreated).toBe(0)
        expect(secondResult.bundlesRotated).toBe(0)
        expect(secondResult.budgetItemsRemoved).toBe(0)
        expect(recursiveSnapshot(tree)).toEqual(snapshot)
    })

    it('solid-bundles the oldest 25 with correct metadata and byte-exact reads', async () => {
        const harness = makeHarness({ now: 10_000 })
        const expected = new Map<number, Buffer>()
        for (let index = 0; index < 25; index++) {
            const raw = rawChat(index, 'mostly-identical-content')
            expected.set(10_000 + index, raw)
            harness.setRow('char', 'chat', raw)
            await harness.store.captureChatPreImage({
                chaId: 'char',
                chatId: 'chat',
                reason: 'autosave',
            })
            harness.advance()
        }

        const result = await harness.store.reconcileChatBackups()
        expect(result.gzipped).toBe(25)
        expect(result.bundlesCreated).toBe(1)
        const directory = chatDir(harness.root, 'char', 'chat')
        const names = fs.readdirSync(directory).sort()
        expect(names).toEqual([
            'archive-10000-10024.bundle',
            'archive-10000-10024.meta.json',
        ])

        const meta = JSON.parse(
            fs.readFileSync(path.join(directory, 'archive-10000-10024.meta.json'), 'utf-8'),
        )
        expect(meta.format).toBe('pocketrisu-chat-backup-bundle-v1')
        expect(meta.entryCount).toBe(25)
        expect(meta.compressedSize).toBe(
            fs.statSync(path.join(directory, 'archive-10000-10024.bundle')).size,
        )
        expect(meta.entries[0]).toMatchObject({
            versionId: 'v-10000-0-autosave',
            ts: 10_000,
            reason: 'autosave',
            offset: 0,
            size: expected.get(10_000)?.length,
        })
        for (let index = 1; index < meta.entries.length; index++) {
            expect(meta.entries[index].offset).toBe(
                meta.entries[index - 1].offset + meta.entries[index - 1].size,
            )
        }

        for (const entry of meta.entries) {
            expect(
                harness.store.readChatBackup('char', 'chat', entry.versionId)
                    ?.equals(expected.get(entry.ts) as Buffer),
            ).toBe(true)
        }
    })

    it.each([
        {
            state: 'non-gzip garbage',
            derivative: () => Buffer.from('garbage'),
        },
        {
            state: 'a valid gzip of the wrong bytes',
            derivative: () => zlib.gzipSync(Buffer.from('wrong backup bytes')),
        },
        {
            state: 'an empty rename-published gzip',
            derivative: () => Buffer.alloc(0),
        },
    ])('regenerates $state instead of deleting its good raw source', async ({ derivative }) => {
        const harness = makeHarness()
        const expected = rawChat(70)
        harness.setRow('char', 'chat', expected)
        await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })

        const directory = chatDir(harness.root, 'char', 'chat')
        const rawFilename = fs.readdirSync(directory).find(name => name.endsWith('.bin')) as string
        const versionId = rawFilename.slice(0, -'.bin'.length)
        const gzipPath = path.join(directory, `${rawFilename}.gz`)
        fs.writeFileSync(gzipPath, derivative())

        await harness.store.reconcileChatBackups()

        expect(harness.store.readChatBackup('char', 'chat', versionId)?.equals(expected)).toBe(true)
        expect(zlib.gunzipSync(fs.readFileSync(gzipPath)).equals(expected)).toBe(true)
    })

    it('keeps loose versions when a corrupt bundle claims them below the threshold', async () => {
        const harness = makeHarness({ now: 30_000, versionsPerBundle: 3 })
        for (let index = 0; index < 2; index++) {
            harness.setRow('char', 'chat', rawChat(80 + index))
            await harness.store.captureChatPreImage({
                chaId: 'char',
                chatId: 'chat',
                reason: 'save',
            })
            harness.advance()
        }

        const directory = chatDir(harness.root, 'char', 'chat')
        const loose = gzipCapturedRawFiles(directory)
        writeCorruptBundleClaim(directory, loose)

        await harness.store.reconcileChatBackups()

        for (const entry of loose) {
            expect(fs.existsSync(path.join(directory, entry.filename))).toBe(true)
            expect(
                harness.store.readChatBackup('char', 'chat', entry.versionId)?.equals(entry.raw),
            ).toBe(true)
        }
    })

    it('regenerates a corrupt bundle that claims a full loose batch', async () => {
        const harness = makeHarness({ now: 40_000, versionsPerBundle: 3 })
        for (let index = 0; index < 3; index++) {
            harness.setRow('char', 'chat', rawChat(90 + index))
            await harness.store.captureChatPreImage({
                chaId: 'char',
                chatId: 'chat',
                reason: 'save',
            })
            harness.advance()
        }

        const directory = chatDir(harness.root, 'char', 'chat')
        const loose = gzipCapturedRawFiles(directory)
        const bundlePath = writeCorruptBundleClaim(directory, loose)

        const result = await harness.store.reconcileChatBackups()

        expect(result.bundlesCreated).toBe(1)
        expect(
            zlib.gunzipSync(fs.readFileSync(bundlePath)).equals(
                Buffer.concat(loose.map(entry => entry.raw)),
            ),
        ).toBe(true)
        for (const entry of loose) {
            expect(fs.existsSync(path.join(directory, entry.filename))).toBe(false)
            expect(
                harness.store.readChatBackup('char', 'chat', entry.versionId)?.equals(entry.raw),
            ).toBe(true)
        }
    })

    it('retains exactly 125 versions and then evicts only the single oldest version', async () => {
        const harness = makeHarness({ now: 20_000 })
        const raws: Buffer[] = []
        for (let index = 0; index < 125; index++) {
            const raw = rawChat(index)
            raws.push(raw)
            harness.setRow('char', 'chat', raw)
            await harness.store.captureChatPreImage({
                chaId: 'char',
                chatId: 'chat',
                reason: 'save',
            })
            harness.advance()
        }

        const boundary = await harness.store.reconcileChatBackups()
        expect(boundary.versionsTrimmed).toBe(0)
        expect(harness.store.listChatBackups('char', 'chat')).toHaveLength(125)
        for (let index = 0; index < raws.length; index++) {
            expect(harness.store.readChatBackup(
                'char',
                'chat',
                `v-${20_000 + index}-0-save`,
            )?.equals(raws[index])).toBe(true)
        }

        const newest = rawChat(125)
        harness.setRow('char', 'chat', newest)
        await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'save',
        })

        const overflow = await harness.store.reconcileChatBackups()
        expect(overflow.versionsTrimmed).toBe(1)
        const versions = harness.store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(125)
        expect(versions[0].versionId).toBe('v-20125-0-save')
        expect(versions.at(-1)?.versionId).toBe('v-20001-0-save')
        expect(harness.store.readChatBackup('char', 'chat', 'v-20000-0-save')).toBeNull()
        expect(harness.store.readChatBackup('char', 'chat', 'v-20001-0-save')
            ?.equals(raws[1])).toBe(true)
        expect(harness.store.readChatBackup('char', 'chat', 'v-20125-0-save')
            ?.equals(newest)).toBe(true)
    })

    it('enforces a configurable exact cap and remains idempotent after trimming a bundle', async () => {
        const harness = makeHarness({
            now: 30_000,
            versionsPerBundle: 2,
            maxBundlesPerChat: 2,
        })
        const raws: Buffer[] = []
        for (let index = 0; index < 7; index++) {
            const raw = rawChat(200 + index)
            raws.push(raw)
            harness.setRow('char', 'chat', raw)
            await harness.store.captureChatPreImage({
                chaId: 'char',
                chatId: 'chat',
                reason: 'small',
            })
            harness.advance()
        }

        const first = await harness.store.reconcileChatBackups()
        expect(first.versionsTrimmed).toBe(1)
        const versions = harness.store.listChatBackups('char', 'chat')
        expect(versions.map(version => version.versionId)).toEqual(
            Array.from({ length: 6 }, (_, index) => `v-${30_006 - index}-0-small`),
        )
        expect(harness.store.readChatBackup('char', 'chat', 'v-30000-0-small')).toBeNull()
        for (let index = 1; index < raws.length; index++) {
            expect(harness.store.readChatBackup(
                'char',
                'chat',
                `v-${30_000 + index}-0-small`,
            )?.equals(raws[index])).toBe(true)
        }

        const newest = rawChat(207)
        harness.setRow('char', 'chat', newest)
        await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
            reason: 'small',
        })
        const next = await harness.store.reconcileChatBackups()
        expect(next.versionsTrimmed).toBe(1)
        expect(harness.store.listChatBackups('char', 'chat').map(version => version.versionId))
            .toEqual(Array.from(
                { length: 6 },
                (_, index) => `v-${30_007 - index}-0-small`,
            ))
        expect(harness.store.readChatBackup('char', 'chat', 'v-30001-0-small')).toBeNull()
        expect(harness.store.readChatBackup('char', 'chat', 'v-30007-0-small')
            ?.equals(newest)).toBe(true)

        const tree = path.join(harness.root, 'chat-backups')
        const snapshot = recursiveSnapshot(tree)
        const idempotent = await harness.store.reconcileChatBackups()
        expect(idempotent.versionsTrimmed).toBe(0)
        expect(recursiveSnapshot(tree)).toEqual(snapshot)
    })

    it('keeps every retained version recoverable when bundle withdrawal fails', async () => {
        const harness = makeHarness({
            now: 40_000,
            versionsPerBundle: 2,
            maxBundlesPerChat: 1,
        })
        const raws: Buffer[] = []
        for (let index = 0; index < 5; index++) {
            const raw = rawChat(300 + index)
            raws.push(raw)
            harness.setRow('char', 'chat', raw)
            await harness.store.captureChatPreImage({
                chaId: 'char',
                chatId: 'chat',
                reason: 'failure',
            })
            harness.advance()
        }

        const unlinkSync = fs.unlinkSync.bind(fs)
        let rejectedWithdrawal = false
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
            if (!rejectedWithdrawal && String(filename).endsWith('.meta.json')) {
                rejectedWithdrawal = true
                throw Object.assign(new Error('injected withdrawal failure'), { code: 'EIO' })
            }
            return unlinkSync(filename)
        })
        const failed = await harness.store.reconcileChatBackups()
            .finally(() => unlinkSpy.mockRestore())

        expect(rejectedWithdrawal).toBe(true)
        expect(failed.versionsTrimmed).toBe(0)
        expect(harness.store.listChatBackups('char', 'chat')).toHaveLength(5)
        for (let index = 0; index < raws.length; index++) {
            expect(harness.store.readChatBackup(
                'char',
                'chat',
                `v-${40_000 + index}-0-failure`,
            )?.equals(raws[index])).toBe(true)
        }

        const retried = await harness.store.reconcileChatBackups()
        expect(retried.versionsTrimmed).toBe(1)
        expect(harness.store.listChatBackups('char', 'chat')).toHaveLength(4)
        expect(harness.store.readChatBackup('char', 'chat', 'v-40000-0-failure')).toBeNull()
        for (let index = 1; index < raws.length; index++) {
            expect(harness.store.readChatBackup(
                'char',
                'chat',
                `v-${40_000 + index}-0-failure`,
            )?.equals(raws[index])).toBe(true)
        }
    })

    it('evicts every eligible unit when necessary and preserves each chat newest', async () => {
        const harness = makeHarness({
            now: 100,
            versionsPerBundle: 3,
            maxBytes: 100 * 1024 * 1024,
        })
        for (const timestamp of [100, 200, 300, 400]) {
            harness.setNow(timestamp)
            harness.setRow('char-a', 'chat-a', rawChat(timestamp))
            await harness.store.captureChatPreImage({
                chaId: 'char-a',
                chatId: 'chat-a',
                reason: 'a',
            })
        }
        for (const timestamp of [150, 250]) {
            harness.setNow(timestamp)
            harness.setRow('char-b', 'chat-b', rawChat(timestamp))
            await harness.store.captureChatPreImage({
                chaId: 'char-b',
                chatId: 'chat-b',
                reason: 'b',
            })
        }
        await harness.store.reconcileChatBackups()
        expect(harness.store.listChatBackups('char-a', 'chat-a').map(v => v.storage))
            .toEqual(['loose', 'bundle', 'bundle', 'bundle'])
        expect(harness.store.listChatBackups('char-b', 'chat-b')).toHaveLength(2)

        harness.setMaxBytes(1)
        const result = await harness.store.reconcileChatBackups()
        expect(result.totalBytes).toBeGreaterThan(result.maxBytes)
        expect(harness.store.listChatBackups('char-a', 'chat-a').map(v => v.ts))
            .toEqual([400])
        expect(harness.store.listChatBackups('char-b', 'chat-b').map(v => v.ts))
            .toEqual([250])
        expect(harness.store.readChatBackup(
            'char-a',
            'chat-a',
            'v-400-0-a',
        )).not.toBeNull()
        expect(harness.store.readChatBackup(
            'char-b',
            'chat-b',
            'v-250-0-b',
        )).not.toBeNull()
    })

    it('evicts one older loose version before a newer cross-chat bundle', async () => {
        const harness = makeHarness({
            versionsPerBundle: 3,
            maxBytes: 100 * 1024 * 1024,
        })
        for (const timestamp of [200, 201, 202, 300]) {
            harness.setNow(timestamp)
            harness.setRow('char-a', 'chat-a', rawChat(timestamp))
            await harness.store.captureChatPreImage({
                chaId: 'char-a',
                chatId: 'chat-a',
                reason: 'a',
            })
        }
        for (const timestamp of [100, 150]) {
            harness.setNow(timestamp)
            harness.setRow('char-b', 'chat-b', rawChat(timestamp))
            await harness.store.captureChatPreImage({
                chaId: 'char-b',
                chatId: 'chat-b',
                reason: 'b',
            })
        }

        const before = await harness.store.reconcileChatBackups()
        const olderLoosePath = path.join(
            chatDir(harness.root, 'char-b', 'chat-b'),
            'v-100-0-b.bin.gz',
        )
        expect(fs.existsSync(olderLoosePath)).toBe(true)
        harness.setMaxBytes(before.totalBytes - fs.statSync(olderLoosePath).size)

        const result = await harness.store.reconcileChatBackups()

        expect(result.budgetItemsRemoved).toBe(1)
        expect(result.totalBytes).toBe(result.maxBytes)
        expect(harness.store.readChatBackup('char-b', 'chat-b', 'v-100-0-b')).toBeNull()
        expect(harness.store.readChatBackup('char-b', 'chat-b', 'v-150-0-b')).not.toBeNull()
        for (const timestamp of [200, 201, 202, 300]) {
            expect(harness.store.readChatBackup(
                'char-a',
                'chat-a',
                `v-${timestamp}-0-a`,
            )).not.toBeNull()
        }
        expect(harness.store.listChatBackups('char-a', 'chat-a').filter(
            version => version.storage === 'bundle',
        )).toHaveLength(3)
    })
})

describe('chat backup listing', () => {
    it('orders and summarizes loose plus bundled versions without decompressing bundles', async () => {
        const harness = makeHarness({ now: 50_000 })
        const expectedSizes = new Map<number, number>()
        for (let index = 0; index < 25; index++) {
            const raw = rawChat(index)
            expectedSizes.set(50_000 + index, raw.length)
            harness.setRow('char/雪', 'chat%one', raw)
            await harness.store.captureChatPreImage({
                chaId: 'char/雪',
                chatId: 'chat%one',
                reason: 'archive',
            })
            harness.advance()
        }
        await harness.store.reconcileChatBackups()

        for (let index = 25; index < 27; index++) {
            const raw = rawChat(index)
            expectedSizes.set(50_000 + index, raw.length)
            harness.setRow('char/雪', 'chat%one', raw)
            await harness.store.captureChatPreImage({
                chaId: 'char/雪',
                chatId: 'chat%one',
                reason: 'loose',
            })
            harness.advance()
        }
        await harness.store.reconcileChatBackups()

        const versions = harness.store.listChatBackups('char/雪', 'chat%one')
        expect(versions).toHaveLength(27)
        expect(versions.map(version => version.ts)).toEqual(
            Array.from({ length: 27 }, (_, index) => 50_026 - index),
        )
        expect(versions.slice(0, 2).every(version => (
            version.storage === 'loose' && version.bundleFile === undefined
        ))).toBe(true)
        expect(versions.slice(2).every(version => (
            version.storage === 'bundle'
            && version.bundleFile === 'archive-50000-50024.bundle'
        ))).toBe(true)
        for (const version of versions) {
            expect(version.size).toBe(expectedSizes.get(version.ts))
        }

        expect(harness.store.listChatBackupChats()).toEqual([{
            chaId: 'char/雪',
            chatId: 'chat%one',
            versionCount: 27,
            newestTs: 50_026,
            oldestTs: 50_000,
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
})
