import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
    Init: vi.fn(async () => undefined),
    getItem: vi.fn(async () => new TextEncoder().encode('{"source":"plain"}')),
    getItemCached: vi.fn(async () => new TextEncoder().encode('{"source":"cached"}')),
}))

vi.mock('../globalApi.svelte', () => ({ forageStorage: storage }))
vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn() }))

// Simulate an older Chromium/WebKit WebView before persistent storage is
// initialized, so the module-level capability test selects the portable path.
const nativeIsWellFormedDescriptor = Object.getOwnPropertyDescriptor(
    String.prototype,
    'isWellFormed',
)
Reflect.deleteProperty(String.prototype, 'isWellFormed')

const {
    decodeStorageKeyComponent,
    hasNativeStringWellFormed,
    makeEncodedStorageKey,
    readPersistentJson,
} = await import('./persistentKv')

afterAll(() => {
    if (nativeIsWellFormedDescriptor) {
        Object.defineProperty(
            String.prototype,
            'isWellFormed',
            nativeIsWellFormedDescriptor,
        )
    }
})

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
    it('uses the portable validator when the WebView lacks the ES2024 method', () => {
        expect(hasNativeStringWellFormed).toBe(false)
        const rawKey = 'legacy WebView 🔑 key'
        const encoded = makeEncodedStorageKey('pluginsave/', rawKey)
        const component = encoded.slice('pluginsave/'.length, -'.json'.length)
        expect(decodeStorageKeyComponent(component)).toBe(rawKey)
    })

    it('rejects lone surrogates before UTF-8 encoding', () => {
        expect(() => makeEncodedStorageKey('pluginsave/', '\uD800'))
            .toThrow('well-formed Unicode')
        expect(() => makeEncodedStorageKey('pluginsave/', '\uDC00'))
            .toThrow('well-formed Unicode')
    })

    it('encodes a literal replacement character normally', () => {
        expect(makeEncodedStorageKey('pluginsave/', '�')).toBe('pluginsave/77-9.json')
    })
})
