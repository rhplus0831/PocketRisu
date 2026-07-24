import { describe, expect, it, vi } from 'vitest'
import cachedReadPkg from './dbCachedRead.cjs'
import utilsPkg from './utils.cjs'
import {
    DB_CACHE_GROUPS,
    decodeAndAssembleCachedDbRead,
    type DbCacheInventory,
} from '../../src/ts/storage/dbCachedRead'

vi.mock('../../src/ts/storage/database.svelte', () => ({}))
vi.mock('../../src/ts/storage/chatStorage', () => ({ chatToStub: (chat: any) => chat }))
vi.mock('../../src/ts/globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const clientRisuSave = await import('../../src/ts/storage/risuSave')

const {
    DB_CACHE_MAX_HASHES,
    computeBufferEtag,
    parseDbCacheInventory,
    prepareDatabaseReadPayload,
    encodeDatabaseSegments,
    buildCachedDbReadEnvelope,
    encodeCachedDbReadEnvelope,
} = cachedReadPkg as any

const {
    calculateHash: serverCalculateHash,
    decodeRisuSave,
    encodeRisuSaveLegacy,
} = utilsPkg as {
    calculateHash: (value: any) => number
    decodeRisuSave: (value: Uint8Array) => Promise<any>
    encodeRisuSaveLegacy: (value: any) => Uint8Array
}

const emptyInventory = (): DbCacheInventory => Object.fromEntries(
    DB_CACHE_GROUPS.map((group) => [group, []]),
) as DbCacheInventory

const representativeDatabase = () => ({
    schemaVersion: 7,
    title: '별빛 / 星 / café',
    explicitUndefined: undefined,
    nested: {
        empty: [],
        numbers: [0, -17, 1.25, 9_007_199_254_740_991],
        object: { present: true, missing: undefined },
    },
    characters: [{
        chaId: 'char-한글',
        name: '리수',
        chats: [{ id: 'chat-1', name: '첫 채팅', _stub: true, folderId: undefined }],
        tags: [],
    }],
    botPresets: [{ id: 'preset-1', name: 'Float preset', temperature: 0.75 }],
    modules: [
        { id: 'module-1', name: 'Módulo', enabled: false, data: { value: undefined } },
        { id: 'module-2', name: 'Empty', lorebook: [] },
    ],
    personas: [],
})

function inventoryAndBytes(encodedSegments: any): {
    inventory: DbCacheInventory
    bytesByHash: Map<string, Uint8Array>
} {
    const inventory = emptyInventory()
    const bytesByHash = new Map<string, Uint8Array>()
    inventory.root = [encodedSegments.root.hash]
    bytesByHash.set(encodedSegments.root.hash, encodedSegments.root.bytes)
    for (const group of DB_CACHE_GROUPS.slice(1)) {
        inventory[group as keyof DbCacheInventory] = encodedSegments[group].map((segment: any) => {
            bytesByHash.set(segment.hash, segment.bytes)
            return segment.hash
        })
    }
    return { inventory, bytesByHash }
}

describe('segmented cached database read', () => {
    it('assembles raw msgpack segments identically to a full legacy decode', async () => {
        const database = representativeDatabase()
        const prepared = prepareDatabaseReadPayload(database)
        const encodedSegments = encodeDatabaseSegments(database)
        const envelope = buildCachedDbReadEnvelope(encodedSegments, parseDbCacheInventory({
            cache: { version: 1, hashes: emptyInventory() },
        }), prepared.etag)

        const assembled = await decodeAndAssembleCachedDbRead(
            encodeCachedDbReadEnvelope(envelope),
            emptyInventory(),
            async () => null,
        )
        const fullDecode = await decodeRisuSave(encodeRisuSaveLegacy(database))

        expect(assembled.database).toEqual(fullDecode)
        expect(Object.prototype.hasOwnProperty.call(assembled.database, 'explicitUndefined')).toBe(true)
        expect(Object.prototype.hasOwnProperty.call(assembled.database.nested.object, 'missing')).toBe(true)
    })

    it('preserves client/server compositional hash parity with the full decode', async () => {
        const database = representativeDatabase()
        const prepared = prepareDatabaseReadPayload(database)
        const encodedSegments = encodeDatabaseSegments(database)
        const envelope = buildCachedDbReadEnvelope(encodedSegments, parseDbCacheInventory({
            cache: { version: 1, hashes: emptyInventory() },
        }), prepared.etag)
        const assembled = (await decodeAndAssembleCachedDbRead(
            encodeCachedDbReadEnvelope(envelope),
            emptyInventory(),
            async () => null,
        )).database
        const fullDecode = await decodeRisuSave(encodeRisuSaveLegacy(database))

        expect(clientRisuSave.calculateHash(assembled)).toBe(clientRisuSave.calculateHash(fullDecode))
        expect(serverCalculateHash(assembled)).toBe(serverCalculateHash(fullDecode))
        expect(clientRisuSave.calculateHash(assembled)).toBe(serverCalculateHash(assembled))
    })

    it('projects empty, full, and mixed inventories as bytes or hashes', async () => {
        const database = representativeDatabase()
        const prepared = prepareDatabaseReadPayload(database)
        const segments = encodeDatabaseSegments(database)
        const all = inventoryAndBytes(segments)

        const misses = buildCachedDbReadEnvelope(segments, parseDbCacheInventory({
            cache: { version: 1, hashes: emptyInventory() },
        }), prepared.etag)
        expect(misses.root).toHaveProperty('bytes')
        expect(misses.characters.every((segment: any) => 'bytes' in segment)).toBe(true)
        expect(misses.botPresets.every((segment: any) => 'bytes' in segment)).toBe(true)
        expect(misses.modules.every((segment: any) => 'bytes' in segment)).toBe(true)

        const hits = buildCachedDbReadEnvelope(segments, parseDbCacheInventory({
            cache: { version: 1, hashes: all.inventory },
        }), prepared.etag)
        expect(hits.root).toEqual({ hash: segments.root.hash })
        expect(hits.characters.every((segment: any) => 'hash' in segment)).toBe(true)
        expect(hits.botPresets.every((segment: any) => 'hash' in segment)).toBe(true)
        expect(hits.modules.every((segment: any) => 'hash' in segment)).toBe(true)

        const mixedInventory = emptyInventory()
        mixedInventory.root = all.inventory.root
        mixedInventory.modules = [all.inventory.modules[0]]
        const mixed = buildCachedDbReadEnvelope(segments, parseDbCacheInventory({
            cache: { version: 1, hashes: mixedInventory },
        }), prepared.etag)
        expect(mixed.root).toHaveProperty('hash')
        expect(mixed.characters[0]).toHaveProperty('bytes')
        expect(mixed.modules[0]).toHaveProperty('hash')
        expect(mixed.modules[1]).toHaveProperty('bytes')

        const assembledHit = await decodeAndAssembleCachedDbRead(
            encodeCachedDbReadEnvelope(hits),
            all.inventory,
            async (hash) => all.bytesByHash.get(hash) ?? null,
        )
        expect(assembledHit.database).toEqual(await decodeRisuSave(encodeRisuSaveLegacy(database)))
    })

    it('rejects malformed and oversized request inventories', () => {
        const valid = { cache: { version: 1, hashes: emptyInventory() } }
        expect(() => parseDbCacheInventory(valid)).not.toThrow()
        expect(() => parseDbCacheInventory(null)).toThrow(/Malformed/)
        expect(() => parseDbCacheInventory({ cache: { version: 2, hashes: emptyInventory() } })).toThrow(/Malformed/)
        expect(() => parseDbCacheInventory({
            cache: { version: 1, hashes: { ...emptyInventory(), root: ['A'.repeat(64)] } },
        })).toThrow(/Malformed/)
        expect(() => parseDbCacheInventory({
            cache: { version: 1, hashes: { ...emptyInventory(), extra: [] } },
        })).toThrow(/Malformed/)
        expect(() => parseDbCacheInventory({
            cache: {
                version: 1,
                hashes: { ...emptyInventory(), characters: Array(DB_CACHE_MAX_HASHES + 1).fill('a'.repeat(64)) },
            },
        })).toThrow(/exceeds 8192/)
    })

    it('uses the same full-blob ETag for cached and ordinary database reads', () => {
        const database = representativeDatabase()
        const prepared = prepareDatabaseReadPayload(database)
        const ordinaryReadBlob = Buffer.from(encodeRisuSaveLegacy(database))
        const envelope = buildCachedDbReadEnvelope(
            encodeDatabaseSegments(database),
            parseDbCacheInventory({ cache: { version: 1, hashes: emptyInventory() } }),
            prepared.etag,
        )

        expect(prepared.fullBlob.equals(ordinaryReadBlob)).toBe(true)
        expect(prepared.etag).toBe(computeBufferEtag(ordinaryReadBlob))
        expect(envelope.etag).toBe(prepared.etag)
    })
})
