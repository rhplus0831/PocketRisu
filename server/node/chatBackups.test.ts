import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
    }) => Promise<string>
    reconcileChatBackups: () => Promise<{
        staleTempsRemoved: number
        gzipped: number
        bundlesCreated: number
        bundlesRotated: number
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
    resolveChatBackupMaxBytes,
    sanitizeBackupReason,
    CHAT_BACKUP_MAX_BYTES_KEY,
    COLD_STORAGE_HEADER,
} = chatBackupsPkg as {
    createChatBackupStore: (options: any) => ChatBackupStore
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

function makeHarness(options: {
    now?: number
    cooldownMs?: number
    versionsPerBundle?: number
    maxBundlesPerChat?: number
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
        getBackupsRoot: () => root,
        readChatRowRaw: (chaId: string, chatId: string) => (
            rows.get(rowKey(chaId, chatId)) ?? null
        ),
        logger,
        now: () => clock,
        cooldownMs: options.cooldownMs ?? 0,
        versionsPerBundle: options.versionsPerBundle ?? 25,
        maxBundlesPerChat: options.maxBundlesPerChat ?? 4,
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

describe('chat backup capture', () => {
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

    it('seeds cooldown from disk after a store restart', async () => {
        const harness = makeHarness({ now: 5_000, cooldownMs: 45_000 })
        harness.setRow('char', 'chat', rawChat(1))
        expect(await harness.store.captureChatPreImage({
            chaId: 'char',
            chatId: 'chat',
        })).toBe('captured')
        harness.store.close()

        const restarted = createChatBackupStore({
            getBackupsRoot: () => harness.root,
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
            getBackupsRoot: () => root,
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

    it('rotates the oldest bundle when a fifth 25-version archive is created', async () => {
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

        const result = await harness.store.reconcileChatBackups()
        expect(result.bundlesCreated).toBe(5)
        expect(result.bundlesRotated).toBe(1)
        const versions = harness.store.listChatBackups('char', 'chat')
        expect(versions).toHaveLength(100)
        expect(versions.every(version => version.storage === 'bundle')).toBe(true)
        expect(harness.store.readChatBackup(
            'char',
            'chat',
            'v-20000-0-save',
        )).toBeNull()
        expect(harness.store.readChatBackup(
            'char',
            'chat',
            'v-20025-0-save',
        )?.equals(raws[25])).toBe(true)
    })

    it('evicts oldest bundles before loose versions and preserves every chat newest', async () => {
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
