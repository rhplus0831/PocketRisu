import { describe, expect, it } from 'vitest'
import {
    DB_CACHE_GROUPS,
    decodeAndAssembleCachedDbRead,
    type DbCacheInventory,
} from './dbCachedRead'
import { encodeRawMsgpack } from './rawMsgpack'

const ETAG = 'a'.repeat(32)

function encodeOwned(value: unknown): Uint8Array {
    return Uint8Array.from(encodeRawMsgpack(value))
}

function emptyInventory(): DbCacheInventory {
    return Object.fromEntries(
        DB_CACHE_GROUPS.map(group => [group, []]),
    ) as DbCacheInventory
}

function envelopeWithCharacters(characterBytes: Uint8Array[]): Uint8Array {
    return encodeOwned({
        version: 1,
        etag: ETAG,
        root: { bytes: encodeOwned({ name: 'bounded-cache' }) },
        characters: characterBytes.map(bytes => ({ bytes })),
        botPresets: [],
        modules: [],
        personas: [],
    })
}

describe('cached database boot staging', () => {
    it('decodes every miss while admitting only entries inside the aggregate byte budget', async () => {
        const firstCharacter = encodeOwned({ id: 'first', payload: 'x'.repeat(32) })
        const secondCharacter = encodeOwned({ id: 'second', payload: 'y'.repeat(32) })
        const root = encodeOwned({ name: 'bounded-cache' })
        const aggregateBudget = root.byteLength + firstCharacter.byteLength

        const assembled = await decodeAndAssembleCachedDbRead(
            envelopeWithCharacters([firstCharacter, secondCharacter]),
            emptyInventory(),
            async () => null,
            { maxBytes: aggregateBudget },
        )

        expect(assembled.database.characters).toEqual([
            { id: 'first', payload: 'x'.repeat(32) },
            { id: 'second', payload: 'y'.repeat(32) },
        ])
        const uniqueEntries = new Map(
            assembled.updates.flatMap(update => update.entries)
                .map(entry => [entry.hash, entry] as const),
        )
        expect([...uniqueEntries.values()].reduce(
            (total, entry) => total + entry.bytes.byteLength,
            0,
        )).toBeLessThanOrEqual(aggregateBudget)
        expect(assembled.updates.find(update => update.key === 'db:root')?.entries)
            .toHaveLength(1)
        expect(assembled.updates.find(update => update.key === 'db:characters')?.entries)
            .toHaveLength(1)
        expect(assembled.updates.find(update => update.key === 'db:characters')?.hashes)
            .toHaveLength(1)
    })

    it('does not hash or retain a miss which exceeds the per-value admission limit', async () => {
        const character = encodeOwned({ id: 'oversized-for-test' })

        const assembled = await decodeAndAssembleCachedDbRead(
            envelopeWithCharacters([character]),
            emptyInventory(),
            async () => null,
            { maxValueBytes: character.byteLength - 1 },
        )

        expect(assembled.database.characters).toEqual([{ id: 'oversized-for-test' }])
        expect(assembled.updates.find(update => update.key === 'db:characters')).toMatchObject({
            hashes: [],
            entries: [],
        })
    })

    it('deduplicates admitted storage without charging the same content twice', async () => {
        const repeated = encodeOwned({ id: 'same' })
        const root = encodeOwned({ name: 'bounded-cache' })

        const assembled = await decodeAndAssembleCachedDbRead(
            envelopeWithCharacters([repeated, repeated]),
            emptyInventory(),
            async () => null,
            { maxBytes: root.byteLength + (repeated.byteLength * 2) },
        )

        const characterUpdate = assembled.updates.find(update => update.key === 'db:characters')
        expect(characterUpdate?.hashes).toHaveLength(2)
        expect(new Set(characterUpdate?.entries.map(entry => entry.hash)).size).toBe(1)
        expect(characterUpdate?.entries[0]).toBe(characterUpdate?.entries[1])
    })
})
