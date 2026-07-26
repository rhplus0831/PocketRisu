import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
    Init: vi.fn(async () => undefined),
    getItem: vi.fn(async () => new TextEncoder().encode('{"source":"plain"}')),
    getItemCached: vi.fn(async () => new TextEncoder().encode('{"source":"cached"}')),
    setItem: vi.fn(async (_key: string, _value: Uint8Array) => undefined),
    clearPluginSaveStorage: vi.fn(async () => 'committed' as const),
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
    clearExternalizedPluginStorage,
    hasNativeStringWellFormed,
    makeEncodedStorageKey,
    readPersistentJson,
    writePersistentJson,
} = await import('./persistentKv')
const {
    BACKUP_ENTRY_NAME_MAX_BYTES,
    makeArchiveSafePluginSaveStorageKey,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
} = await import('./pluginSaveKeyPolicy')

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
    storage.setItem.mockClear()
    storage.clearPluginSaveStorage.mockClear()
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

    it('rejects a poisoned JSON row instead of treating it as a missing value', async () => {
        storage.getItem.mockResolvedValueOnce(new TextEncoder().encode(''))

        await expect(readPersistentJson('pluginsave/poisoned')).rejects.toThrow(SyntaxError)
    })
})

describe('persistent JSON write transport', () => {
    it('validates before touching storage', async () => {
        await expect(writePersistentJson('pluginsave/invalid', { nested: undefined }))
            .rejects.toThrow(TypeError)

        expect(storage.setItem).not.toHaveBeenCalled()
    })

    it('writes the validated detached JSON bytes', async () => {
        const value = { nested: ['safe', -0] }
        const writing = writePersistentJson('pluginsave/valid', value)
        value.nested[0] = 'mutated-after-call'
        await writing

        expect(storage.setItem).toHaveBeenCalledOnce()
        const [key, bytes] = storage.setItem.mock.calls[0]
        expect(key).toBe('pluginsave/valid')
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ nested: ['safe', 0] })
    })
})

describe('externalized plugin clear transport', () => {
    it('uses one fixed-namespace server mutation without listing or deleting rows', async () => {
        await expect(clearExternalizedPluginStorage()).resolves.toBeUndefined()

        expect(storage.clearPluginSaveStorage).toHaveBeenCalledOnce()
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

    it('enforces the exact value and metadata archive-name boundaries', () => {
        const maxValueName = makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_PREFIX,
            'v'.repeat(756),
        )
        const maxMetaName = makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_META_PREFIX,
            'm'.repeat(752),
        )

        expect(new TextEncoder().encode(maxValueName)).toHaveLength(BACKUP_ENTRY_NAME_MAX_BYTES)
        expect(new TextEncoder().encode(maxMetaName)).toHaveLength(BACKUP_ENTRY_NAME_MAX_BYTES)
        expect(() => makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_PREFIX,
            'v'.repeat(757),
        )).toThrow('too long for backup archives')
        expect(() => makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_META_PREFIX,
            'm'.repeat(753),
        )).toThrow('too long for backup archives')
    })

    it('measures multibyte identifiers by encoded UTF-8 bytes, not string length', () => {
        const maxUtf8Key = 'é'.repeat(376) // 376 UTF-16 code units, 752 UTF-8 bytes
        expect(new TextEncoder().encode(maxUtf8Key)).toHaveLength(752)
        expect(() => makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_META_PREFIX,
            maxUtf8Key,
        )).not.toThrow()

        const oversizedUtf8Key = `${maxUtf8Key}a` // 377 code units, 753 UTF-8 bytes
        expect(oversizedUtf8Key).toHaveLength(377)
        expect(() => makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_META_PREFIX,
            oversizedUtf8Key,
        )).toThrow('too long for backup archives')
    })
})
