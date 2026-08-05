import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import chatRowsPkg from './chatRows.cjs'
import chunkStorePkg from './chunkStore.cjs'
import utilsPkg from './utils.cjs'

interface ChatRowStore {
    chatRowKey: (chaId: string, chatId: string) => string
    parseChatRowKey: (key: string) => { chaId: string; chatId: string } | null
    readChatRow: (chaId: string, chatId: string) => Promise<any | null>
    readChatRowRaw: (chaId: string, chatId: string) => Buffer | null
    readChatRowRawWithMetadata: (chaId: string, chatId: string) => {
        key: string
        rowToken: string
        bytes: Buffer
        contentHash: string
        coldStorage: boolean | null
    } | null
    readChatRowRawWithMetadataAsync: (
        chaId: string,
        chatId: string,
    ) => Promise<ReturnType<ChatRowStore['readChatRowRawWithMetadata']>>
    repairChatRowMetadata: (row: any, coldStorage: boolean) => boolean
    writeChatRow: (chaId: string, chatId: string, chat: any) => string
    writeChatRowIfUnchanged: (
        chaId: string,
        chatId: string,
        row: any,
        chat: any,
    ) => string | null
    writeChatRowRaw: (chaId: string, chatId: string, value: Buffer) => string
    writeChatRowRawOwned: (
        chaId: string,
        chatId: string,
        value: Buffer,
        options?: { coldStorage?: boolean; messageCount?: number; logSupported?: boolean },
    ) => string
    appendChatDelta: (
        chaId: string,
        chatId: string,
        payload: any,
        options?: { maxResultBytes?: number },
    ) => any
    inspectChatDelta: ChatRowStore['appendChatDelta']
    compactChatRow: (
        chaId: string,
        chatId: string,
        options?: { force?: boolean },
    ) => { compacted: boolean; reason: string }
    operationEntriesForKey: (key: string) => any[]
    metadataForKey: (key: string) => any
    materializeChatRowBytesFromReader: (reader: any, key: string) => Buffer | null
    deleteChatRow: (chaId: string, chatId: string) => void
    deleteChatRowsForChar: (chaId: string) => number
    listChatRowKeysForChar: (chaId: string) => string[]
    listAllChatRowKeys: () => string[]
    chatBytesForChar: (chaId: string) => number
    chatToStub: (chat: any) => any
    validateDatabaseShape: (dbObj: any) => any
    hasChatPayloads: (dbObj: any) => boolean
    referencedChatRowKeys: (dbObj: any) => Set<string>
    extractPayloadChats: (dbObj: any) => number
    deleteRemovedChatRows: (oldStrippedDb: any, newStrippedDb: any) => number
    sweepOrphanChatRows: (
        strippedDb: any,
        opts?: {
            now?: number
            graceMs?: number
            capturePreImage?: (identity: {
                chaId: string
                chatId: string
                key: string
            }) => Promise<string> | string
        },
    ) => Promise<{ deleted: number; skippedRecent: number; skippedPreImage: number }>
    splitFullDb: (dbObj: any) => {
        strippedDb: any
        chatEntries: Array<{ chaId: string; chatId: string; chat: any }>
    }
    assembleFullDb: (strippedDb: any) => Promise<any>
    assignMissingChatIds: (dbObj: any) => boolean
    dedupeCharacterIds: (
        dbObj: any,
        makeId?: () => string,
    ) => { reassignedDuplicateChaIds: number }
    findDuplicateChaIds: (dbObj: any) => string[]
    findDuplicateChatIds: (dbObj: any) => Array<{
        chaId: string | null
        characterIndex: number
        chatId: string
        firstIndex: number
        duplicateIndex: number
    }>
    normalizeOrphanFolderIds: (dbObj: any) => boolean
    ingestFullDatabase: (
        raw: Buffer | object,
        opts?: {
            beforeDecode?: () => Promise<Buffer | undefined> | Buffer | undefined
            restoreColdStorageCharacters?: (dbObj: any) => any
        },
    ) => Promise<{
        strippedDb: any
        stats: {
            chats: number
            deletedStale: number
            assignedMissingChatIds: boolean
            normalizedOrphanFolderIds: boolean
            reassignedDuplicateChaIds: number
            [key: string]: any
        }
    }>
    ingestStreamingDatabase: (
        source: Buffer | { filePath: string },
        opts?: {
            restoreColdStorageCharacters?: (dbObj: any) => any
        },
    ) => Promise<{
        strippedDb: any
        stats: {
            chats: number
            deletedStale: number
            assignedMissingChatIds: boolean
            normalizedOrphanFolderIds: boolean
            reassignedDuplicateChaIds: number
            [key: string]: any
        }
    }>
}

const {
    createChatRowStore,
    chatRowKey,
    parseChatRowKey,
    chatToStub,
    validateDatabaseShape,
    hasChatPayloads,
    splitFullDb,
    findDuplicateChaIds,
    findDuplicateChatIds,
} = chatRowsPkg as {
    createChatRowStore: (options: any) => ChatRowStore
    chatRowKey: (chaId: string, chatId: string) => string
    parseChatRowKey: (key: string) => { chaId: string; chatId: string } | null
    chatToStub: (chat: any) => any
    validateDatabaseShape: ChatRowStore['validateDatabaseShape']
    hasChatPayloads: (dbObj: any) => boolean
    splitFullDb: ChatRowStore['splitFullDb']
    findDuplicateChaIds: ChatRowStore['findDuplicateChaIds']
    findDuplicateChatIds: ChatRowStore['findDuplicateChatIds']
}
const { createChunkStore, isChunkableKey } = chunkStorePkg as {
    createChunkStore: (db: any, opts?: { threshold?: number }) => {
        getValue: (key: string) => Buffer | null
        putValue: (key: string, value: Buffer) => void
        dropValue: (key: string) => void
        writeValueToFile: (key: string, filePath: string, options?: any) => Promise<any>
        sizeValue: (key: string) => number | null
    }
    isChunkableKey: (key: string) => boolean
}
const { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } = utilsPkg as {
    decodeRisuSave: (value: Buffer | Uint8Array) => Promise<any>
    encodeRisuSaveLegacy: (value: any) => Uint8Array
    normalizeJSON: (value: any) => any
}

function makeHarness(options: {
    threshold?: number
    beforeSet?: (key: string, value: Buffer) => void
    randomUUID?: () => string
    chatDeltaCompactMaxOperations?: number
    chatDeltaCompactMaxBytes?: number
    chatDeltaCompactionFailpoint?: (stage: string, key: string) => void
    kvGetAsync?: (key: string, read: (key: string) => Buffer | null) => Promise<Buffer | null>
} = {}) {
    const db = new Database(':memory:')
    db.exec(
        'CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    )
    const chunks = createChunkStore(db, { threshold: options.threshold ?? 1024 * 1024 })
    const rawSet = db.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    const allKeys = db.prepare('SELECT key FROM kv')
    const prefixKeys = db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'")
    const prefixSizes = db.prepare(
        "SELECT key, LENGTH(value) size FROM kv WHERE key LIKE ? ESCAPE '\\'",
    )
    const updatedAt = db.prepare('SELECT updated_at FROM kv WHERE key = ?')
    const escapePrefix = (prefix: string) => prefix.replace(/[\\%_]/g, '\\$&') + '%'

    const kvGet = (key: string) => chunks.getValue(key)
    const kvSet = (key: string, value: Buffer) => {
        options.beforeSet?.(key, value)
        if (isChunkableKey(key)) chunks.putValue(key, value)
        else rawSet.run(key, value, Date.now())
    }
    const kvDel = (key: string) => chunks.dropValue(key)
    const kvGetUpdatedAt = (key: string) => (
        (updatedAt.get(key) as { updated_at: number } | undefined)?.updated_at ?? null
    )
    const kvList = (prefix?: string) => (
        prefix
            ? prefixKeys.all(escapePrefix(prefix)).map((row: any) => row.key as string)
            : allKeys.all().map((row: any) => row.key as string)
    )
    const kvListWithSizes = (prefix: string) => prefixSizes
        .all(escapePrefix(prefix))
        .map((row: any) => ({ key: row.key as string, size: row.size as number }))

    const store = createChatRowStore({
        db,
        kvGet,
        kvGetAsync: options.kvGetAsync
            ? (key: string) => options.kvGetAsync!(key, kvGet)
            : undefined,
        kvSet,
        kvDel,
        kvList,
        kvListWithSizes,
        kvWriteToFile: (key: string, filePath: string, streamOptions?: any) => (
            chunks.writeValueToFile(key, filePath, streamOptions)
        ),
        kvSize: (key: string) => chunks.sizeValue(key),
        kvGetUpdatedAt,
        randomUUID: options.randomUUID,
        chatDeltaCompactMaxOperations: options.chatDeltaCompactMaxOperations,
        chatDeltaCompactMaxBytes: options.chatDeltaCompactMaxBytes,
        chatDeltaCompactionFailpoint: options.chatDeltaCompactionFailpoint,
    })
    return { db, store, kvGet, kvSet }
}

describe('chat row keys', () => {
    it('round-trips encoded components containing slash, percent, and unicode', () => {
        const chaId = 'char/50%/다람쥐'
        const chatId = 'chat/%/雪'
        const key = chatRowKey(chaId, chatId)

        expect(key).toBe(
            `chats/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`,
        )
        expect(key.split('/')).toHaveLength(3)
        expect(parseChatRowKey(key)).toEqual({ chaId, chatId })
        expect(parseChatRowKey('chats/bad/%E0%A4%A')).toBeNull()
        expect(parseChatRowKey('assets/a/b')).toBeNull()
    })
})

describe('findDuplicateChaIds', () => {
    it('returns each duplicated truthy character id once in encounter order', () => {
        expect(findDuplicateChaIds({
            characters: [
                { chaId: 'dup' },
                { chaId: '' },
                { chaId: 'other' },
                { chaId: 'dup' },
                { chaId: 'dup' },
                { chaId: 'other' },
                {},
            ],
        })).toEqual(['dup', 'other'])
    })

    it('is pure and tolerates missing character arrays', () => {
        const dbObj = { characters: [{ chaId: 'same' }, { chaId: 'same' }] }
        const before = structuredClone(dbObj)

        expect(findDuplicateChaIds(dbObj)).toEqual(['same'])
        expect(dbObj).toEqual(before)
        expect(findDuplicateChaIds({})).toEqual([])
        expect(findDuplicateChaIds(null)).toEqual([])
    })
})

describe('chat row IO', () => {
    it('writes the legacy chat wire format and decodes it on read', async () => {
        const { store, kvGet } = makeHarness()
        const chat = {
            id: 'chat-1',
            name: 'First',
            message: [{ role: 'user', data: 'hello' }],
            folderId: null,
        }

        store.writeChatRow('char-1', chat.id, chat)
        const raw = kvGet(chatRowKey('char-1', chat.id))
        expect(raw?.equals(Buffer.from(encodeRisuSaveLegacy(chat)))).toBe(true)
        expect(store.readChatRowRaw('char-1', chat.id)?.equals(raw as Buffer)).toBe(true)
        expect(await store.readChatRow('char-1', chat.id)).toEqual(chat)
        expect(await store.readChatRow('char-1', 'missing')).toBeNull()
    })

    it('supports verbatim raw writes, lists, and character-wide deletion', () => {
        const { store, kvGet } = makeHarness()
        const a = Buffer.from('aaa')
        const b = Buffer.from('bbbbb')
        store.writeChatRowRaw('char/one', 'a', a)
        store.writeChatRowRaw('char/one', 'b', b)
        store.writeChatRowRaw('char-two', 'c', Buffer.from('x'))

        expect(kvGet(chatRowKey('char/one', 'a'))?.equals(a)).toBe(true)
        expect(store.listChatRowKeysForChar('char/one').sort()).toEqual([
            chatRowKey('char/one', 'a'),
            chatRowKey('char/one', 'b'),
        ])
        expect(store.chatBytesForChar('char/one')).toBe(a.length + b.length)
        expect(store.deleteChatRowsForChar('char/one')).toBe(2)
        expect(store.listChatRowKeysForChar('char/one')).toEqual([])
        expect(store.listAllChatRowKeys()).toEqual([chatRowKey('char-two', 'c')])
    })

    it('returns the written-byte digest and makes buffer ownership explicit', () => {
        const observed: Buffer[] = []
        const { store } = makeHarness({
            beforeSet: (key, value) => {
                if (key.startsWith('chats/')) observed.push(value)
            },
        })
        const retained = Buffer.from(encodeRisuSaveLegacy({
            id: 'retained',
            name: 'Retained',
            message: [],
        }))
        const retainedHash = store.writeChatRowRaw('char', 'retained', retained)
        expect(observed.at(-1)).not.toBe(retained)
        expect(retainedHash).toBe(createHash('sha256').update(retained).digest('hex'))

        const owned = Buffer.from(encodeRisuSaveLegacy({
            id: 'owned',
            name: 'Owned',
            message: [],
        }))
        const ownedHash = store.writeChatRowRawOwned('char', 'owned', owned, {
            coldStorage: false,
        })
        expect(observed.at(-1)).toBe(owned)
        expect(ownedHash).toBe(createHash('sha256').update(owned).digest('hex'))
    })

    it('binds cold-state metadata to row bytes and repairs legacy gaps lazily', () => {
        const { db, store, kvSet } = makeHarness()
        const chat = {
            id: 'chat',
            name: 'Warm',
            message: [{ role: 'user', data: 'hello' }],
        }
        const hash = store.writeChatRow('char', chat.id, chat)
        const selected = store.readChatRowRawWithMetadata('char', chat.id)
        expect(selected).toMatchObject({ contentHash: hash, coldStorage: false })

        db.prepare('DELETE FROM chat_row_metadata WHERE row_key = ?')
            .run(chatRowKey('char', chat.id))
        const legacy = store.readChatRowRawWithMetadata('char', chat.id)
        expect(legacy?.coldStorage).toBeNull()
        expect(store.repairChatRowMetadata(legacy, false)).toBe(true)
        expect(store.readChatRowRawWithMetadata('char', chat.id)?.coldStorage).toBe(false)

        db.prepare(`
            UPDATE chat_row_metadata
               SET content_sha256 = ?, cold_storage = 1
             WHERE row_key = ?
        `).run('0'.repeat(64), chatRowKey('char', chat.id))
        const inconsistent = store.readChatRowRawWithMetadata('char', chat.id)
        expect(inconsistent?.coldStorage).toBeNull()
        expect(store.repairChatRowMetadata(inconsistent, false)).toBe(true)

        const replacement = Buffer.from(encodeRisuSaveLegacy({
            ...chat,
            message: [{ role: 'user', data: 'replacement' }],
        }))
        kvSet(chatRowKey('char', chat.id), replacement)
        expect(store.readChatRowRawWithMetadata('char', chat.id)).toMatchObject({
            contentHash: createHash('sha256').update(replacement).digest('hex'),
            coldStorage: null,
        })
        expect(store.repairChatRowMetadata(legacy, false)).toBe(false)
    })

    it('does not let a cold cache-fill overwrite a concurrently replaced row', () => {
        const { store } = makeHarness()
        const cold = {
            id: 'chat',
            name: 'Cold',
            message: [{ data: '\uEF01COLDSTORAGE\uEF01coldstorage/key' }],
        }
        store.writeChatRow('char', cold.id, cold)
        const selected = store.readChatRowRawWithMetadata('char', cold.id)
        const replacement = { ...cold, name: 'Newer', message: [] }
        store.writeChatRow('char', cold.id, replacement)

        expect(store.writeChatRowIfUnchanged(
            'char', cold.id, selected, { ...cold, name: 'Restored', message: [] },
        )).toBeNull()
        expect(store.readChatRowRawWithMetadata('char', cold.id)?.coldStorage).toBe(false)
    })
})

describe('chat operation-log rows', () => {
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

    function delta(base: any, result: any, patch: any[]) {
        const baseBytes = Buffer.from(encodeRisuSaveLegacy(base))
        const resultBytes = Buffer.from(encodeRisuSaveLegacy(result))
        return {
            baseBytes,
            resultBytes,
            payload: {
                version: 1,
                baseHash: digest(baseBytes),
                resultHash: digest(resultBytes),
                resultSize: resultBytes.length,
                patch,
            },
        }
    }

    it('atomically appends and materializes exact logical bytes while advancing metadata', () => {
        let uuid = 0
        const { db, store, kvGet } = makeHarness({
            randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
        })
        const base = {
            id: 'chat',
            name: 'Chat',
            message: [{ role: 'user', data: 'one' }],
        }
        const result = {
            ...base,
            message: [
                { role: 'user', data: 'one edited' },
                { role: 'char', data: 'two' },
            ],
        }
        const prepared = delta(base, result, [
            { op: 'replace', path: '/message/0', value: result.message[0] },
            { op: 'add', path: '/message/-', value: result.message[1] },
        ])
        store.writeChatRow('char', 'chat', base)
        const key = store.chatRowKey('char', 'chat')
        const baseToken = store.metadataForKey(key).rowToken

        expect(store.inspectChatDelta('char', 'chat', prepared.payload)).toEqual({ applied: true })
        expect(store.appendChatDelta('char', 'chat', prepared.payload)).toMatchObject({
            applied: true,
            hash: prepared.payload.resultHash,
            size: prepared.resultBytes.length,
            logCount: 1,
        })
        expect(kvGet(key)?.equals(prepared.baseBytes)).toBe(true)
        expect(store.readChatRowRaw('char', 'chat')?.equals(prepared.resultBytes)).toBe(true)
        expect(store.metadataForKey(key)).toMatchObject({
            contentHash: prepared.payload.resultHash,
            contentSize: prepared.resultBytes.length,
            messageCount: 2,
            logSupported: true,
            logCount: 1,
        })
        expect(store.metadataForKey(key).rowToken).not.toBe(baseToken)
        expect(store.operationEntriesForKey(key)).toHaveLength(1)
        expect(db.prepare('SELECT COUNT(*) count FROM chat_row_operations').get())
            .toEqual({ count: 1 })
    })

    it('refuses missing, unsupported, stale, malformed, and conflicting bases without an append', () => {
        const { db, store, kvSet } = makeHarness()
        const base = { id: 'chat', message: [{ data: 'one' }] }
        const result = { ...base, message: [{ data: 'two' }] }
        const prepared = delta(base, result, [
            { op: 'replace', path: '/message/0', value: result.message[0] },
        ])

        expect(store.appendChatDelta('char', 'missing', prepared.payload))
            .toMatchObject({ applied: false, code: 'CHAT_DELTA_BASE_MISSING' })
        kvSet(store.chatRowKey('char', 'legacy'), prepared.baseBytes)
        expect(store.appendChatDelta('char', 'legacy', prepared.payload))
            .toMatchObject({ applied: false, code: 'CHAT_DELTA_BASE_UNAVAILABLE' })

        store.writeChatRow('char', 'chat', base)
        expect(store.appendChatDelta('char', 'chat', {
            ...prepared.payload,
            baseHash: '0'.repeat(64),
        })).toMatchObject({ applied: false, code: 'CHAT_DELTA_BASE_MISMATCH' })
        expect(() => store.appendChatDelta('char', 'chat', {
            ...prepared.payload,
            patch: [{ op: 'replace', path: '/name', value: 'forbidden' }],
        })).toThrow(/replace path does not identify an existing message/)

        expect(store.appendChatDelta('char', 'chat', prepared.payload).applied).toBe(true)
        db.prepare('DELETE FROM chat_row_operations WHERE row_key = ?')
            .run(store.chatRowKey('char', 'chat'))
        expect(store.appendChatDelta('char', 'chat', {
            ...prepared.payload,
            baseHash: prepared.payload.resultHash,
        })).toMatchObject({ applied: false, code: 'CHAT_DELTA_LOG_CONFLICT' })
    })

    it('compacts past the count threshold and retains exact bytes with an empty log', () => {
        const { store, kvGet } = makeHarness({ chatDeltaCompactMaxOperations: 2 })
        const base = { id: 'chat', message: [{ data: 'zero' }] }
        const one = { ...base, message: [{ data: 'one' }] }
        const two = { ...base, message: [{ data: 'two' }] }
        const first = delta(base, one, [
            { op: 'replace', path: '/message/0', value: one.message[0] },
        ])
        const second = delta(one, two, [
            { op: 'replace', path: '/message/0', value: two.message[0] },
        ])
        store.writeChatRow('char', 'chat', base)
        expect(store.appendChatDelta('char', 'chat', first.payload).shouldCompact).toBe(false)
        expect(store.appendChatDelta('char', 'chat', second.payload).shouldCompact).toBe(true)
        const before = store.metadataForKey(store.chatRowKey('char', 'chat'))

        expect(store.compactChatRow('char', 'chat')).toEqual({
            compacted: true,
            reason: 'compacted',
        })
        const key = store.chatRowKey('char', 'chat')
        expect(kvGet(key)?.equals(second.resultBytes)).toBe(true)
        expect(store.readChatRowRaw('char', 'chat')?.equals(second.resultBytes)).toBe(true)
        expect(store.operationEntriesForKey(key)).toEqual([])
        expect(store.metadataForKey(key)).toMatchObject({
            contentHash: second.payload.resultHash,
            contentSize: second.resultBytes.length,
            messageCount: 1,
            logCount: 0,
            logBytes: 0,
        })
        expect(store.metadataForKey(key).rowToken).not.toBe(before.rowToken)
    })

    it('rolls back a crash failpoint after the base write, leaving base+log readable', () => {
        const { store, kvGet } = makeHarness({
            chatDeltaCompactionFailpoint: (stage) => {
                if (stage === 'after-base-write') throw new Error('injected crash')
            },
        })
        const base = { id: 'chat', message: [{ data: 'base' }] }
        const result = { ...base, message: [{ data: 'logical' }] }
        const prepared = delta(base, result, [
            { op: 'replace', path: '/message/0', value: result.message[0] },
        ])
        store.writeChatRow('char', 'chat', base)
        store.appendChatDelta('char', 'chat', prepared.payload)
        const key = store.chatRowKey('char', 'chat')
        const before = store.metadataForKey(key)

        expect(() => store.compactChatRow('char', 'chat', { force: true }))
            .toThrow('injected crash')
        expect(kvGet(key)?.equals(prepared.baseBytes)).toBe(true)
        expect(store.operationEntriesForKey(key)).toHaveLength(1)
        expect(store.metadataForKey(key)).toEqual(before)
        expect(store.readChatRowRaw('char', 'chat')?.equals(prepared.resultBytes)).toBe(true)
    })

    it('retries an async GET selection when a delta advances the row token', async () => {
        const gate = Promise.withResolvers<void>()
        let reads = 0
        const { store } = makeHarness({
            kvGetAsync: async (key, read) => {
                const selected = read(key)
                if (++reads === 1) await gate.promise
                return selected
            },
        })
        const base = { id: 'chat', message: [{ data: 'base' }] }
        const result = { ...base, message: [{ data: 'after raced append' }] }
        const prepared = delta(base, result, [
            { op: 'replace', path: '/message/0', value: result.message[0] },
        ])
        store.writeChatRow('char', 'chat', base)

        const pending = store.readChatRowRawWithMetadataAsync('char', 'chat')
        store.appendChatDelta('char', 'chat', prepared.payload)
        gate.resolve()

        const selected = await pending
        expect(reads).toBe(2)
        expect(selected?.bytes.equals(prepared.resultBytes)).toBe(true)
        expect(selected?.contentHash).toBe(prepared.payload.resultHash)
    })
})

describe('chatToStub', () => {
    it('preserves metadata by key presence, including explicit null and undefined', () => {
        const full = {
            id: 'chat',
            name: null,
            message: [],
            lastDate: undefined,
            folderId: null,
            modules: undefined,
        }
        const stub = chatToStub(full)

        expect(stub).toEqual({
            id: 'chat',
            name: '',
            _stub: true,
            lastDate: undefined,
            folderId: null,
            modules: undefined,
        })
        expect('lastDate' in stub).toBe(true)
        expect('folderId' in stub).toBe(true)
        expect('modules' in stub).toBe(true)
    })

    it('fast-paths only real stubs and collapses _stub+message hybrids', () => {
        const realStub = { id: 'stub', name: 'Stub', _stub: true, folderId: null }
        const hybrid = { id: 'hybrid', name: 'Hybrid', _stub: true, message: [] }

        expect(chatToStub(realStub)).toBe(realStub)
        expect(chatToStub(hybrid)).toEqual({
            id: 'hybrid',
            name: 'Hybrid',
            _stub: true,
        })
        expect(chatToStub({ id: 'truthy', name: 'Truthy', _stub: 1 })).not.toHaveProperty(
            'message',
        )
    })
})

describe('splitFullDb and assembleFullDb', () => {
    it.each([
        ['null root', null],
        ['array root', []],
        ['non-array characters', { characters: 'not-an-array' }],
        ['non-array chats', { characters: [{ chats: {} }] }],
        ['non-array chat folders', { characters: [{ chatFolders: {} }] }],
        ['non-array message', { characters: [{ chats: [{ message: 'not-an-array' }] }] }],
    ])('rejects the %s traversal shape before splitting', (_label, value) => {
        expect(() => validateDatabaseShape(value)).toThrow(TypeError)
        expect(() => splitFullDb(value)).toThrow(TypeError)
    })

    it('accepts the legacy fresh-install empty database envelope', () => {
        const value = {}
        expect(validateDatabaseShape(value)).toBe(value)
        expect(splitFullDb(value)).toEqual({ strippedDb: value, chatEntries: [] })
    })

    it('preserves legacy null character, chat, and folder placeholders', () => {
        const value = {
            characters: [null, { chats: [null], chatFolders: [null] }],
        }
        expect(validateDatabaseShape(value)).toBe(value)
        expect(splitFullDb(value).strippedDb.characters).toEqual(value.characters)
    })

    it('extracts payload chats into rows and replaces them with unique, healed stubs', async () => {
        const { store } = makeHarness()
        const dbObj = {
            characters: [{
                chaId: 'char',
                chats: [
                    { id: 'duplicate', name: 'First', message: [{ data: 'one' }] },
                    { id: 'duplicate', name: 'Hybrid', _stub: true, message: [{ data: 'two' }] },
                    { id: 'pending', name: 'Pending', _stub: true },
                ],
            }],
        }

        expect(hasChatPayloads(dbObj)).toBe(true)
        expect(store.extractPayloadChats(dbObj)).toBe(2)
        expect(hasChatPayloads(dbObj)).toBe(false)
        expect(dbObj.characters[0].chats.every(chat => chat._stub === true)).toBe(true)

        const [first, second] = dbObj.characters[0].chats
        expect(first.id).toBe('duplicate')
        expect(second.id).not.toBe('duplicate')
        expect(await store.readChatRow('char', first.id)).toMatchObject({
            id: first.id,
            message: [{ data: 'one' }],
        })
        const healed = await store.readChatRow('char', second.id)
        expect(healed).toMatchObject({ id: second.id, message: [{ data: 'two' }] })
        expect(healed).not.toHaveProperty('_stub')
    })

    it('round-trips a normalized full DB without mutating the input', async () => {
        const { store } = makeHarness()
        const original = normalizeJSON({
            version: 1,
            characters: [
                {
                    chaId: 'char-1',
                    name: 'Character',
                    chatFolders: [{ id: 'folder-1' }],
                    chats: [
                        {
                            id: 'chat-1',
                            name: 'Chat',
                            folderId: 'folder-1',
                            modules: ['module'],
                            message: [{ role: 'char', data: 'hello' }],
                        },
                    ],
                },
                {
                    name: 'No ID',
                    chats: [{ id: 'untouched', message: [{ data: 'kept inline' }] }],
                },
            ],
        })
        const before = structuredClone(original)
        const { strippedDb, chatEntries } = store.splitFullDb(original)

        expect(original).toEqual(before)
        expect(chatEntries).toHaveLength(1)
        expect(strippedDb.characters[1]).toBe(original.characters[1])
        for (const entry of chatEntries) {
            store.writeChatRow(entry.chaId, entry.chatId, entry.chat)
        }
        expect(await store.assembleFullDb(strippedDb)).toEqual(original)
    })

    it('recovers hybrids and never restores their _stub flag', async () => {
        const { store } = makeHarness()
        const hybrid = {
            id: 'hybrid',
            name: 'Hybrid',
            _stub: true,
            message: [{ role: 'user', data: 'survives' }],
        }
        const input = { characters: [{ chaId: 'char', chats: [hybrid] }] }
        const { strippedDb, chatEntries } = store.splitFullDb(input)

        expect(hybrid._stub).toBe(true)
        expect(chatEntries[0].chat).not.toHaveProperty('_stub')
        expect(strippedDb.characters[0].chats[0]._stub).toBe(true)
        store.writeChatRow('char', 'hybrid', chatEntries[0].chat)
        const assembled = await store.assembleFullDb(strippedDb)
        expect(assembled.characters[0].chats[0].message).toEqual(hybrid.message)
        expect(assembled.characters[0].chats[0]).not.toHaveProperty('_stub')
    })

    it('preserves duplicate payload chats by assigning the later one a fresh id', () => {
        const input = {
            characters: [{
                chaId: 'char',
                chats: [
                    { id: 'duplicate', name: 'First', message: [{ data: 'one' }] },
                    { id: 'duplicate', name: 'Second', message: [{ data: 'two' }] },
                ],
            }],
        }
        const { strippedDb, chatEntries } = splitFullDb(input)

        expect(chatEntries).toHaveLength(2)
        expect(chatEntries[0].chatId).toBe('duplicate')
        expect(chatEntries[1].chatId).not.toBe('duplicate')
        expect(new Set(chatEntries.map(entry => entry.chatId)).size).toBe(2)
        expect(strippedDb.characters[0].chats.map((chat: any) => chat.id)).toEqual(
            chatEntries.map(entry => entry.chatId),
        )
        expect(input.characters[0].chats[1].id).toBe('duplicate')
    })

    it('detects duplicate full and stub chat ids within a character', () => {
        const input = {
            characters: [
                {
                    chaId: 'char-a',
                    chats: [
                        { id: 'duplicate', name: 'Full', message: [] },
                        { id: 'duplicate', name: 'Stub', _stub: true },
                        { id: '', name: 'Missing', _stub: true },
                    ],
                },
                {
                    chaId: 'char-b',
                    chats: [{ id: 'duplicate', name: 'Allowed elsewhere', _stub: true }],
                },
            ],
        }

        expect(findDuplicateChatIds(input)).toEqual([{
            chaId: 'char-a',
            characterIndex: 0,
            chatId: 'duplicate',
            firstIndex: 0,
            duplicateIndex: 1,
        }])
    })

    it('passes through bare stubs and assigns ids to missing payload chats', () => {
        const bareStub = { id: 'pending', name: 'Pending', _stub: true }
        const missingId = { name: 'Missing', message: [{ data: 'payload' }] }
        const input = {
            characters: [{ chaId: 'char', chats: [bareStub, missingId] }],
        }
        const { strippedDb, chatEntries } = splitFullDb(input)

        expect(chatEntries).toHaveLength(1)
        expect(chatEntries[0].chat.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )
        expect(strippedDb.characters[0].chats[0]).toBe(bareStub)
        expect(strippedDb.characters[0].chats[1].id).toBe(chatEntries[0].chat.id)
        expect(missingId).not.toHaveProperty('id')
    })

    it('applies stub metadata with in-semantics and leaves missing rows bare', async () => {
        const { store } = makeHarness()
        store.writeChatRow('char', 'chat', {
            id: 'row-id',
            name: 'Row name',
            _stub: true,
            folderId: 'old-folder',
            modules: ['row-module'],
            message: [{ data: 'payload' }],
        })
        const bare = { id: 'missing', name: 'Bare', _stub: true }
        const stub = {
            id: 'chat',
            name: 'Stub name',
            _stub: true,
            lastDate: undefined,
            folderId: null,
        }
        const assembled = await store.assembleFullDb({
            characters: [{ chaId: 'char', chats: [stub, bare] }],
        })
        const merged = assembled.characters[0].chats[0]

        expect(merged.id).toBe('chat')
        expect(merged.name).toBe('Stub name')
        expect(merged.folderId).toBeNull()
        expect(merged.modules).toEqual(['row-module'])
        expect('lastDate' in merged).toBe(true)
        expect(merged.lastDate).toBeUndefined()
        expect(merged).not.toHaveProperty('_stub')
        expect(assembled.characters[0].chats[1]).toBe(bare)
    })
})

describe('chat row orphan deletion', () => {
    it('deletes only rows whose character/chat stub was removed', async () => {
        const { store } = makeHarness()
        for (const [chaId, chatId] of [
            ['char-a', 'keep'],
            ['char-a', 'remove-chat'],
            ['char-b', 'remove-character'],
        ]) {
            store.writeChatRow(chaId, chatId, {
                id: chatId,
                message: [{ data: chatId }],
            })
        }

        const oldDb = {
            characters: [
                {
                    chaId: 'char-a',
                    chats: [
                        { id: 'keep', _stub: true },
                        { id: 'remove-chat', _stub: true },
                    ],
                },
                {
                    chaId: 'char-b',
                    chats: [{ id: 'remove-character', _stub: true }],
                },
            ],
        }
        const newDb = {
            characters: [{
                chaId: 'char-a',
                chats: [{ id: 'keep', _stub: true }],
            }],
        }

        expect(store.deleteRemovedChatRows(oldDb, newDb)).toBe(2)
        expect(await store.readChatRow('char-a', 'keep')).not.toBeNull()
        expect(await store.readChatRow('char-a', 'remove-chat')).toBeNull()
        expect(await store.readChatRow('char-b', 'remove-character')).toBeNull()
    })

    it('sweeps old unreferenced rows but preserves referenced and recent rows', async () => {
        const { db, store } = makeHarness()
        const now = 10_000_000
        const hour = 60 * 60 * 1000
        for (const chatId of ['referenced', 'old-orphan', 'recent-orphan']) {
            store.writeChatRow('char', chatId, {
                id: chatId,
                message: [{ data: chatId }],
            })
        }
        const setUpdatedAt = db.prepare('UPDATE kv SET updated_at = ? WHERE key = ?')
        setUpdatedAt.run(now - 2 * hour, store.chatRowKey('char', 'referenced'))
        setUpdatedAt.run(now - 2 * hour, store.chatRowKey('char', 'old-orphan'))
        setUpdatedAt.run(now - 30 * 60 * 1000, store.chatRowKey('char', 'recent-orphan'))

        const capturePreImage = vi.fn(async () => 'captured')
        const result = await store.sweepOrphanChatRows({
            characters: [{
                chaId: 'char',
                chats: [{ id: 'referenced', _stub: true }],
            }],
        }, { now, graceMs: hour, capturePreImage })

        expect(result).toEqual({ deleted: 1, skippedRecent: 1, skippedPreImage: 0 })
        expect(capturePreImage).toHaveBeenCalledWith({
            chaId: 'char',
            chatId: 'old-orphan',
            key: store.chatRowKey('char', 'old-orphan'),
        })
        expect(await store.readChatRow('char', 'referenced')).not.toBeNull()
        expect(await store.readChatRow('char', 'old-orphan')).toBeNull()
        expect(await store.readChatRow('char', 'recent-orphan')).not.toBeNull()
    })
})

describe('ingestFullDatabase', () => {
    it('reassigns duplicate character ids before writing colliding chat rows', async () => {
        let nextId = 0
        const { store } = makeHarness({
            randomUUID: () => `fresh-character-${++nextId}`,
        })
        const result = await store.ingestFullDatabase({
            characters: [
                {
                    chaId: 'dup-cha',
                    name: 'A',
                    chats: [{ id: 'chat-1', name: 'A chat', message: [{ data: 'A' }] }],
                },
                {
                    chaId: 'dup-cha',
                    name: 'B',
                    chats: [{ id: 'chat-1', name: 'B chat', message: [{ data: 'B' }] }],
                },
            ],
        })

        const characterIds = result.strippedDb.characters.map((character: any) => character.chaId)
        expect(characterIds).toEqual(['dup-cha', 'fresh-character-1'])
        expect(store.listAllChatRowKeys().sort()).toEqual([
            store.chatRowKey('dup-cha', 'chat-1'),
            store.chatRowKey('fresh-character-1', 'chat-1'),
        ].sort())
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters.map((character: any) => character.chats[0].message[0].data))
            .toEqual(['A', 'B'])
        expect(result.stats.reassignedDuplicateChaIds).toBe(1)
    })

    it('preserves a reassigned character stub by copying its existing row', async () => {
        const { store } = makeHarness({ randomUUID: () => 'moved-character' })
        const storedChat = {
            id: 'stored-chat',
            name: 'Stored payload',
            message: [{ data: 'survives reassignment' }],
        }
        store.writeChatRow('dup-cha', 'stored-chat', storedChat)
        const oldRaw = store.readChatRowRaw('dup-cha', 'stored-chat')

        const result = await store.ingestFullDatabase({
            characters: [
                {
                    chaId: 'dup-cha',
                    name: 'Keeper',
                    chats: [{ id: 'stored-chat', name: 'Keeper stub', _stub: true }],
                },
                {
                    chaId: 'dup-cha',
                    name: 'Moved',
                    chats: [{ id: 'stored-chat', name: 'Moved stub', _stub: true }],
                },
            ],
        })

        expect(result.stats.reassignedDuplicateChaIds).toBe(1)
        expect(store.readChatRowRaw('dup-cha', 'stored-chat')?.equals(oldRaw as Buffer)).toBe(true)
        expect(store.readChatRowRaw('moved-character', 'stored-chat')?.equals(oldRaw as Buffer))
            .toBe(true)
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters[1].chats[0]).toMatchObject({
            name: 'Moved stub',
            message: [{ data: 'survives reassignment' }],
        })
    })

    it('reassigns every later occurrence when three characters share one id', async () => {
        let nextId = 0
        const { store } = makeHarness({ randomUUID: () => `unique-${++nextId}` })
        const result = await store.ingestFullDatabase({
            characters: ['A', 'B', 'C'].map(data => ({
                chaId: 'triplicate',
                chats: [{ id: 'same-chat', message: [{ data }] }],
            })),
        })

        const characterIds = result.strippedDb.characters.map((character: any) => character.chaId)
        expect(characterIds).toEqual(['triplicate', 'unique-1', 'unique-2'])
        expect(new Set(characterIds).size).toBe(3)
        expect(store.listAllChatRowKeys()).toHaveLength(3)
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters.map((character: any) => character.chats[0].message[0].data))
            .toEqual(['A', 'B', 'C'])
        expect(result.stats.reassignedDuplicateChaIds).toBe(2)
    })

    it('writes object input, removes stale rows, preserves stub-referenced rows, and sets marker', async () => {
        const { store, kvGet } = makeHarness()
        const survivor = { id: 'survivor', name: 'Stored', message: [{ data: 'old' }] }
        store.writeChatRow('char', 'survivor', survivor)
        store.writeChatRow('char', 'stale', {
            id: 'stale',
            name: 'Stale',
            message: [],
        })

        const result = await store.ingestFullDatabase({
            characters: [{
                chaId: 'char',
                chats: [
                    { id: 'survivor', name: 'Pending metadata', _stub: true },
                    { id: 'new', name: 'New', message: [{ data: 'new' }] },
                ],
            }],
        })

        expect(result.stats).toMatchObject({ chats: 1, deletedStale: 1 })
        expect(result.stats.reassignedDuplicateChaIds).toBe(0)
        expect(await store.readChatRow('char', 'survivor')).toEqual(survivor)
        expect(await store.readChatRow('char', 'stale')).toBeNull()
        expect(await store.readChatRow('char', 'new')).toMatchObject({ id: 'new' })
        expect(kvGet('migration/chats-externalized')?.toString()).toBe('done')
        expect(kvGet('migration/character-defaults-normalized')?.toString()).toBe('done')
        expect(
            normalizeJSON(await decodeRisuSave(kvGet('database/database.bin') as Buffer)),
        ).toEqual(result.strippedDb)
    })

    it('assigns a missing character id before writing and preserves its hydratable chats', async () => {
        const { store } = makeHarness({ randomUUID: () => 'full-character-id' })
        const result = await store.ingestFullDatabase({
            characters: [{
                chaId: '',
                chats: [{ id: 'full-chat', name: 'Full', message: [{ data: 'kept' }] }],
            }],
        })

        const character = result.strippedDb.characters[0]
        expect(character.chaId).toBe('full-character-id')
        expect(store.listAllChatRowKeys()).toEqual([
            store.chatRowKey('full-character-id', 'full-chat'),
        ])
        expect(store.listAllChatRowKeys().some(key => key.startsWith('chats/undefined/')))
            .toBe(false)
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters[0].chats[0].message).toEqual([{ data: 'kept' }])
    })

    it('uses fresh Buffer input from beforeDecode and invokes hooks in order', async () => {
        const { store } = makeHarness()
        const order: string[] = []
        const ignored = Buffer.from(encodeRisuSaveLegacy({ characters: [] }))
        const fresh = Buffer.from(encodeRisuSaveLegacy({
            characters: [{
                chaId: 'char',
                chatFolders: [],
                chats: [{
                    name: 'From fresh buffer',
                    folderId: 'deleted-folder',
                    message: [],
                }],
            }],
        }))

        const result = await store.ingestFullDatabase(ignored, {
            beforeDecode: () => {
                order.push('beforeDecode')
                return fresh
            },
            restoreColdStorageCharacters: (dbObj: any) => {
                order.push('restoreColdStorageCharacters')
                expect(dbObj.characters[0].chats[0].id).toBeTruthy()
                expect(dbObj.characters[0].chats[0].folderId).toBe('deleted-folder')
                return { restored: 2, failed: 0, failedNames: [] }
            },
        })

        expect(order).toEqual(['beforeDecode', 'restoreColdStorageCharacters'])
        expect(result.stats).toMatchObject({
            chats: 1,
            restored: 2,
            failed: 0,
            assignedMissingChatIds: true,
            normalizedOrphanFolderIds: true,
        })
        expect(result.strippedDb.characters[0].chats[0].folderId).toBeNull()
        expect(result.strippedDb.characters[0].chats[0].name).toBe('From fresh buffer')
    })

    it('rolls back the full nested transaction when a chat write throws mid-ingest', async () => {
        let chatWrites = 0
        const { db, store } = makeHarness({
            threshold: 64,
            beforeSet: (key) => {
                if (key.startsWith('chats/') && ++chatWrites === 2) {
                    throw new Error('injected chat write failure')
                }
            },
        })
        const input = {
            padding: 'x'.repeat(20_000),
            characters: [{
                chaId: 'char',
                chats: [
                    { id: 'one', name: 'One', message: [{ data: 'a'.repeat(10_000) }] },
                    { id: 'two', name: 'Two', message: [{ data: 'b'.repeat(10_000) }] },
                ],
            }],
        }

        await expect(store.ingestFullDatabase(input)).rejects.toThrow(
            'injected chat write failure',
        )
        expect(db.prepare('SELECT COUNT(*) n FROM kv').get().n).toBe(0)
        expect(db.prepare('SELECT COUNT(*) n FROM manifest_chunks').get().n).toBe(0)
        expect(db.prepare('SELECT COUNT(*) n FROM chunks').get().n).toBe(0)
    })
})

describe('ingestStreamingDatabase', () => {
    it('reassigns duplicate character ids before streaming colliding chat rows', async () => {
        let nextId = 0
        const { store } = makeHarness({
            randomUUID: () => `stream-character-${++nextId}`,
        })
        const source = Buffer.from(encodeRisuSaveLegacy({
            characters: [
                {
                    chats: [{ id: 'chat-1', name: 'A chat', message: [{ data: 'A' }] }],
                    chaId: 'dup-cha',
                    name: 'A',
                },
                {
                    chats: [{ id: 'chat-1', name: 'B chat', message: [{ data: 'B' }] }],
                    chaId: 'dup-cha',
                    name: 'B',
                },
            ],
        }))

        const result = await store.ingestStreamingDatabase(source)
        const characterIds = result.strippedDb.characters.map((character: any) => character.chaId)
        expect(new Set(characterIds).size).toBe(2)
        expect(store.listAllChatRowKeys().sort()).toEqual(characterIds.map((chaId: string) => (
            store.chatRowKey(chaId, 'chat-1')
        )).sort())
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters.map((character: any) => character.chats[0].message[0].data))
            .toEqual(['A', 'B'])
        expect(result.stats.reassignedDuplicateChaIds).toBe(1)
    })

    it('copies an existing stub row when its character id is reassigned mid-walk', async () => {
        const { store } = makeHarness({ randomUUID: () => 'stream-moved-character' })
        const storedChat = {
            id: 'stored-chat',
            name: 'Stored payload',
            message: [{ data: 'streaming stub survives' }],
        }
        store.writeChatRow('dup-cha', 'stored-chat', storedChat)
        const oldRaw = store.readChatRowRaw('dup-cha', 'stored-chat')
        const source = Buffer.from(encodeRisuSaveLegacy({
            characters: [
                {
                    chaId: 'dup-cha',
                    chats: [{ id: 'stored-chat', name: 'Keeper stub', _stub: true }],
                },
                {
                    chaId: 'dup-cha',
                    chats: [{ id: 'stored-chat', name: 'Moved stub', _stub: true }],
                },
            ],
        }))

        const result = await store.ingestStreamingDatabase(source)

        expect(result.stats.reassignedDuplicateChaIds).toBe(1)
        expect(store.readChatRowRaw('dup-cha', 'stored-chat')?.equals(oldRaw as Buffer)).toBe(true)
        expect(
            store.readChatRowRaw('stream-moved-character', 'stored-chat')?.equals(oldRaw as Buffer),
        ).toBe(true)
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters[1].chats[0]).toMatchObject({
            name: 'Moved stub',
            message: [{ data: 'streaming stub survives' }],
        })
    })

    it('sweeps chatless characters with the same duplicate-id state', async () => {
        let nextId = 0
        const { store } = makeHarness({ randomUUID: () => `swept-${++nextId}` })
        const source = Buffer.from(encodeRisuSaveLegacy({
            characters: [
                { chaId: 'dup-cha', name: 'Chatless', chats: [] },
                {
                    chaId: 'dup-cha',
                    name: 'Streamed',
                    chats: [{ id: 'chat-1', message: [{ data: 'kept' }] }],
                },
            ],
        }))

        const result = await store.ingestStreamingDatabase(source)
        const characterIds = result.strippedDb.characters.map((character: any) => character.chaId)

        expect(new Set(characterIds).size).toBe(2)
        expect(result.stats.reassignedDuplicateChaIds).toBe(1)
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters[1].chats[0].message).toEqual([{ data: 'kept' }])
    })

    it('keeps a missing-id character inline until the restored remainder can be assigned safely', async () => {
        const { store, kvGet } = makeHarness({ randomUUID: () => 'stream-character-id' })
        const source = Buffer.from(encodeRisuSaveLegacy({
            characters: [{
                chaId: '',
                chats: [{ id: 'stream-chat', name: 'Stream', message: [{ data: 'kept' }] }],
            }],
        }))

        const result = await store.ingestStreamingDatabase(source, {
            restoreColdStorageCharacters: (dbObj: any) => {
                expect(store.listAllChatRowKeys()).toEqual([])
                dbObj.characters[0].chaId = ''
                return { restored: 1, failed: 0, failedNames: [] }
            },
        })

        const character = result.strippedDb.characters[0]
        expect(character.chaId).toBe('stream-character-id')
        expect(store.listAllChatRowKeys()).toEqual([
            store.chatRowKey('stream-character-id', 'stream-chat'),
        ])
        expect(store.listAllChatRowKeys().some(key => key.startsWith('chats/undefined/')))
            .toBe(false)
        expect(kvGet('migration/character-defaults-normalized')?.toString()).toBe('done')
        const assembled = await store.assembleFullDb(result.strippedDb)
        expect(assembled.characters[0].chats[0].message).toEqual([{ data: 'kept' }])
    })
})
