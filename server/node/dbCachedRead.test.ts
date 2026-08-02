import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
    encodeRawMsgpack,
    createDatabaseSegmentMemo,
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

function hashBytes(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function inventoryFromEnvelope(envelope: any): DbCacheInventory {
    const inventory = emptyInventory()
    inventory.root = [hashBytes(envelope.root.bytes)]
    for (const group of DB_CACHE_GROUPS.slice(1)) {
        inventory[group as keyof DbCacheInventory] = envelope[group]
            .map((segment: any) => hashBytes(segment.bytes))
    }
    return inventory
}

function countingSegmentEncoder() {
    let calls = 0
    return {
        encode(value: unknown) {
            calls += 1
            const bytes = encodeRawMsgpack(value)
            return { hash: hashBytes(bytes), bytes }
        },
        calls: () => calls,
    }
}

describe('segmented cached database read', () => {
    it('memoizes an unchanged publication so a fully warm read encodes no segments', () => {
        const database = representativeDatabase()
        const prepared = prepareDatabaseReadPayload(database)
        const counter = countingSegmentEncoder()
        const memo = createDatabaseSegmentMemo({ encodeSegment: counter.encode })
        const empty = parseDbCacheInventory({ cache: { version: 1, hashes: emptyInventory() } })

        const cold = memo.build(database, empty, prepared.etag, 41)
        expect(cold.kind).toBe('envelope')
        expect(cold.stats.encodedSegments).toBeGreaterThan(0)
        expect(cold.stats.reusedSegments).toBe(0)
        const coldCalls = counter.calls()

        const fullInventory = inventoryFromEnvelope(cold.envelope)
        const warm = memo.build(
            database,
            parseDbCacheInventory({ cache: { version: 1, hashes: fullInventory } }),
            prepared.etag,
            41,
        )

        expect(counter.calls()).toBe(coldCalls)
        expect(warm.stats.encodedSegments).toBe(0)
        expect(warm.stats.reusedSegments).toBe(coldCalls)
        expect(warm.envelope.root).toEqual({ hash: fullInventory.root[0] })
        for (const group of DB_CACHE_GROUPS.slice(1)) {
            expect(warm.envelope[group].every((segment: any) => 'hash' in segment)).toBe(true)
        }
    })

    it('carries only unchanged copy-on-write segments into the next revision', () => {
        const database = representativeDatabase()
        const prepared = prepareDatabaseReadPayload(database)
        const counter = countingSegmentEncoder()
        const memo = createDatabaseSegmentMemo({ encodeSegment: counter.encode })
        const empty = parseDbCacheInventory({ cache: { version: 1, hashes: emptyInventory() } })
        const initial = memo.build(database, empty, prepared.etag, 7)
        const initialCalls = counter.calls()
        const initialInventory = inventoryFromEnvelope(initial.envelope)

        const changed = {
            ...database,
            characters: [{ ...database.characters[0], name: 'Changed' }],
        }
        memo.preserveForNextRevision()
        const next = memo.build(
            changed,
            parseDbCacheInventory({ cache: { version: 1, hashes: initialInventory } }),
            prepareDatabaseReadPayload(changed).etag,
            8,
        )

        expect(counter.calls() - initialCalls).toBe(1)
        expect(next.stats.encodedSegments).toBe(1)
        expect(next.stats.reusedSegments).toBe(initialCalls - 1)
        expect(next.envelope.root).toHaveProperty('hash')
        expect(next.envelope.characters[0]).toHaveProperty('bytes')
        expect(next.envelope.modules.every((segment: any) => 'hash' in segment)).toBe(true)
    })

    it('does not cross a revision without an explicit copy-on-write handoff', () => {
        const database = representativeDatabase()
        const counter = countingSegmentEncoder()
        const memo = createDatabaseSegmentMemo({ encodeSegment: counter.encode })
        const empty = parseDbCacheInventory({ cache: { version: 1, hashes: emptyInventory() } })
        const first = memo.build(database, empty, 'a'.repeat(32), 12)
        const firstCalls = counter.calls()

        const second = memo.build(database, empty, 'b'.repeat(32), 13)

        expect(second.stats.encodedSegments).toBe(firstCalls)
        expect(second.stats.reusedSegments).toBe(0)
        expect(counter.calls()).toBe(firstCalls * 2)
    })

    it('does not retain segment bytes beyond its aggregate or entry budgets', () => {
        const database = representativeDatabase()
        const counter = countingSegmentEncoder()
        const memo = createDatabaseSegmentMemo({
            encodeSegment: counter.encode,
            maxBytes: 0,
            maxEntries: 0,
        })
        const empty = parseDbCacheInventory({ cache: { version: 1, hashes: emptyInventory() } })

        const first = memo.build(database, empty, 'a'.repeat(32), 18)
        const firstCalls = counter.calls()
        expect(first.stats).toMatchObject({ retainedBytes: 0, retainedEntries: 0 })

        const second = memo.build(database, empty, 'a'.repeat(32), 18)
        expect(second.stats).toMatchObject({
            encodedSegments: firstCalls,
            reusedSegments: 0,
            retainedBytes: 0,
            retainedEntries: 0,
        })
    })

    it('bypasses the segmented envelope for an oversized root and memoizes that decision', () => {
        const database = {
            ...representativeDatabase(),
            largeInlineRoot: 'x'.repeat(1024),
        }
        const counter = countingSegmentEncoder()
        const memo = createDatabaseSegmentMemo({
            encodeSegment: counter.encode,
            maxValueBytes: 128,
        })
        const empty = parseDbCacheInventory({ cache: { version: 1, hashes: emptyInventory() } })

        const first = memo.build(database, empty, 'a'.repeat(32), 21)
        expect(first).toMatchObject({
            kind: 'raw-boot',
            reason: 'oversized-root',
            stats: { encodedSegments: 1, reusedSegments: 0 },
        })

        const second = memo.build(database, empty, 'a'.repeat(32), 21)
        expect(second).toMatchObject({
            kind: 'raw-boot',
            stats: { encodedSegments: 0, reusedSegments: 1 },
        })
        expect(counter.calls()).toBe(1)
    })

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

    it('round-trips a map32 database through full and segmented server codecs', async () => {
        const keyCount = 65_536
        const pluginCustomStorage = Object.fromEntries(
            Array.from({ length: keyCount }, (_, index) => [`key-${index}`, index]),
        )
        const database = { ...representativeDatabase(), pluginCustomStorage }
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

        expect(Object.keys(assembled.database.pluginCustomStorage)).toHaveLength(keyCount)
        expect(assembled.database.pluginCustomStorage['key-65535']).toBe(65_535)
        expect(assembled.database).toEqual(fullDecode)
    })

    it('detaches long-lived decoded binaries from retained cache segment bytes', async () => {
        const database = {
            ...representativeDatabase(),
            binary: new Uint8Array([1, 2, 3, 4]),
        }
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
        const rootBytes = assembled.updates[0].entries[0].bytes

        expect(Array.from(assembled.database.binary)).toEqual([1, 2, 3, 4])
        expect(assembled.database.binary.buffer).not.toBe(rootBytes.buffer)
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
