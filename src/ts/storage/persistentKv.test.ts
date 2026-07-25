import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
    Init: vi.fn(async () => undefined),
    getItem: vi.fn(async () => new TextEncoder().encode('{"source":"plain"}')),
    getItemCached: vi.fn(async () => new TextEncoder().encode('{"source":"cached"}')),
}))

vi.mock('../globalApi.svelte', () => ({ forageStorage: storage }))
vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn() }))

const { makeEncodedStorageKey, readPersistentJson } = await import('./persistentKv')

beforeEach(() => {
    storage.getItem.mockClear()
    storage.getItemCached.mockClear()
})

describe('persistent JSON read transport', () => {
    it('uses the ordinary read unless the caller explicitly opts into caching', async () => {
        await expect(readPersistentJson<{ source: string }>('draft/key')).resolves.toEqual({ source: 'plain' })
        expect(storage.getItem).toHaveBeenCalledWith('draft/key')
        expect(storage.getItemCached).not.toHaveBeenCalled()
    })

    it('uses the hash-negotiated read only for an explicit cached request', async () => {
        await expect(readPersistentJson<{ source: string }>('pluginsave/value', { cached: true }))
            .resolves.toEqual({ source: 'cached' })
        expect(storage.getItemCached).toHaveBeenCalledWith('pluginsave/value')
        expect(storage.getItem).not.toHaveBeenCalled()
    })
})

describe('encoded storage keys', () => {
    it('rejects lone surrogates before UTF-8 encoding', () => {
        expect(() => makeEncodedStorageKey('pluginsave/', '\uD800'))
            .toThrow('well-formed Unicode')
    })

    it('encodes a literal replacement character normally', () => {
        expect(makeEncodedStorageKey('pluginsave/', '�')).toBe('pluginsave/77-9.json')
    })
})
