import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import chatRowsPkg from './chatRows.cjs'
import chunkStorePkg from './chunkStore.cjs'
import utilsPkg from './utils.cjs'

interface ChatRowStore {
    chatRowKey: (chaId: string, chatId: string) => string
    parseChatRowKey: (key: string) => { chaId: string; chatId: string } | null
    readChatRow: (chaId: string, chatId: string) => Promise<any | null>
    readChatRowRaw: (chaId: string, chatId: string) => Buffer | null
    writeChatRow: (chaId: string, chatId: string, chat: any) => void
    writeChatRowRaw: (chaId: string, chatId: string, value: Buffer) => void
    deleteChatRow: (chaId: string, chatId: string) => void
    deleteChatRowsForChar: (chaId: string) => number
    listChatRowKeysForChar: (chaId: string) => string[]
    listAllChatRowKeys: () => string[]
    chatBytesForChar: (chaId: string) => number
    chatToStub: (chat: any) => any
    hasChatPayloads: (dbObj: any) => boolean
    referencedChatRowKeys: (dbObj: any) => Set<string>
    extractPayloadChats: (dbObj: any) => number
    deleteRemovedChatRows: (oldStrippedDb: any, newStrippedDb: any) => number
    sweepOrphanChatRows: (
        strippedDb: any,
        opts?: { now?: number; graceMs?: number },
    ) => { deleted: number; skippedRecent: number }
    splitFullDb: (dbObj: any) => {
        strippedDb: any
        chatEntries: Array<{ chaId: string; chatId: string; chat: any }>
    }
    assembleFullDb: (strippedDb: any) => Promise<any>
    assignMissingChatIds: (dbObj: any) => boolean
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
            [key: string]: any
        }
    }>
}

const {
    createChatRowStore,
    chatRowKey,
    parseChatRowKey,
    chatToStub,
    hasChatPayloads,
    splitFullDb,
} = chatRowsPkg as {
    createChatRowStore: (options: any) => ChatRowStore
    chatRowKey: (chaId: string, chatId: string) => string
    parseChatRowKey: (key: string) => { chaId: string; chatId: string } | null
    chatToStub: (chat: any) => any
    hasChatPayloads: (dbObj: any) => boolean
    splitFullDb: ChatRowStore['splitFullDb']
}
const { createChunkStore, isChunkableKey } = chunkStorePkg as {
    createChunkStore: (db: any, opts?: { threshold?: number }) => {
        getValue: (key: string) => Buffer | null
        putValue: (key: string, value: Buffer) => void
        dropValue: (key: string) => void
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
        kvSet,
        kvDel,
        kvList,
        kvListWithSizes,
        kvGetUpdatedAt,
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

        const result = store.sweepOrphanChatRows({
            characters: [{
                chaId: 'char',
                chats: [{ id: 'referenced', _stub: true }],
            }],
        }, { now, graceMs: hour })

        expect(result).toEqual({ deleted: 1, skippedRecent: 1 })
        expect(await store.readChatRow('char', 'referenced')).not.toBeNull()
        expect(await store.readChatRow('char', 'old-orphan')).toBeNull()
        expect(await store.readChatRow('char', 'recent-orphan')).not.toBeNull()
    })
})

describe('ingestFullDatabase', () => {
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
        expect(await store.readChatRow('char', 'survivor')).toEqual(survivor)
        expect(await store.readChatRow('char', 'stale')).toBeNull()
        expect(await store.readChatRow('char', 'new')).toMatchObject({ id: 'new' })
        expect(kvGet('migration/chats-externalized')?.toString()).toBe('done')
        expect(
            normalizeJSON(await decodeRisuSave(kvGet('database/database.bin') as Buffer)),
        ).toEqual(result.strippedDb)
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
