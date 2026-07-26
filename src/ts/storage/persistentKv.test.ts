import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    PluginStorageMutationRequest,
    PluginStorageMutationResult,
} from './pluginStorageMutation'

const mutatePluginStorage = vi.hoisted(() => vi.fn<
    (request: PluginStorageMutationRequest) => Promise<PluginStorageMutationResult>
>(async (request) => ({
    outcome: 'committed',
    operation: request.operation,
    verification: 'verified',
})))

const storage = vi.hoisted(() => ({
    Init: vi.fn(async () => undefined),
    getStorageCapacity: vi.fn(async () => ({ freeBytes: 1234 })),
    listEntriesWithSizes: vi.fn(async () => [{ key: 'pluginsave/a.json', size: 17 }]),
    getItem: vi.fn(async () => new TextEncoder().encode('{"source":"plain"}')),
    getItemCached: vi.fn(async () => new TextEncoder().encode('{"source":"cached"}')),
    mutatePluginStorage,
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
    getPersistentStorageFreeBytes,
    hasNativeStringWellFormed,
    listPersistentEntriesWithSizes,
    makeEncodedStorageKey,
    mutatePersistentPluginStorage,
    removePersistentPluginStoragePreservingOwner,
    preparePersistentJson,
    restorePersistentPluginStoragePair,
    readPersistentJson,
    readPersistentJsonRow,
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
    storage.mutatePluginStorage.mockClear()
    storage.mutatePluginStorage.mockImplementation(async (request) => ({
        outcome: 'committed',
        operation: request.operation,
        verification: 'verified',
    }))
    storage.getStorageCapacity.mockClear()
    storage.listEntriesWithSizes.mockClear()
})

describe('persistent JSON read transport', () => {
    it('forwards authoritative save-volume capacity without materializing values', async () => {
        await expect(getPersistentStorageFreeBytes()).resolves.toBe(1234)
        expect(storage.getStorageCapacity).toHaveBeenCalledOnce()
    })

    it('forwards authoritative logical row sizes without reading row bodies', async () => {
        await expect(listPersistentEntriesWithSizes('pluginsave/')).resolves.toEqual([
            { key: 'pluginsave/a.json', size: 17 },
        ])
        expect(storage.listEntriesWithSizes).toHaveBeenCalledWith('pluginsave/')
        expect(storage.getItem).not.toHaveBeenCalled()
        expect(storage.getItemCached).not.toHaveBeenCalled()
    })

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

    it('binds plugin row reads to the selected database generation', async () => {
        await expect(readPersistentJson<{ source: string }>('pluginsave/value', {
            cached: true,
            pluginStorageGeneration: 'selected-generation',
        })).resolves.toEqual({ source: 'cached' })
        expect(storage.getItemCached).toHaveBeenCalledWith('pluginsave/value', {
            pluginStorageGeneration: 'selected-generation',
        })
    })

    it('rejects a poisoned JSON row instead of treating it as a missing value', async () => {
        storage.getItem.mockResolvedValueOnce(new TextEncoder().encode(''))

        await expect(readPersistentJson('pluginsave/poisoned')).rejects.toThrow(SyntaxError)
    })

    it('distinguishes an encoded JSON null row from a missing row', async () => {
        storage.getItem
            .mockResolvedValueOnce(new TextEncoder().encode('null'))
            .mockResolvedValueOnce(null as any)

        await expect(readPersistentJsonRow('pluginsave/null.json')).resolves.toEqual({
            kind: 'value',
            value: null,
        })
        await expect(readPersistentJsonRow('pluginsave/missing.json')).resolves.toEqual({
            kind: 'missing',
        })
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

describe('atomic plugin storage mutation transport', () => {
    it('sends one generation-bound value-only remove that preserves ownership', async () => {
        await removePersistentPluginStoragePreservingOwner(
            'pluginsave/YWxwaGE.json',
            undefined,
            'selected-generation',
        )

        expect(storage.mutatePluginStorage).toHaveBeenCalledOnce()
        expect(storage.mutatePluginStorage).toHaveBeenCalledWith({
            operation: 'remove',
            valueKey: 'pluginsave/YWxwaGE.json',
            preserveOwner: true,
            generation: 'selected-generation',
        })
    })

    it('serializes an exact recovery sidecar into the acknowledged mutation', async () => {
        await restorePersistentPluginStoragePair(
            'pluginsave/YWxwaGE.json',
            { generation: 3 },
            { plugin: 'Original', updatedAt: 7 },
        )

        const request = storage.mutatePluginStorage.mock.calls[0][0]
        expect(JSON.parse(new TextDecoder().decode(request.valueBytes))).toEqual({ generation: 3 })
        expect(JSON.parse(new TextDecoder().decode(request.ownerRecordBytes))).toEqual({
            plugin: 'Original',
            updatedAt: 7,
        })
        expect(request.preserveOwner).toBeUndefined()
    })

    it('requests byte-exact owner preservation when recovery has no inline sidecar', async () => {
        await restorePersistentPluginStoragePair(
            'pluginsave/YWxwaGE.json',
            { generation: 3 },
            undefined,
        )

        expect(storage.mutatePluginStorage.mock.calls[0][0]).toMatchObject({
            operation: 'set',
            preserveOwner: true,
        })
    })

    it('validates and detaches set bytes before invoking the atomic primitive', async () => {
        const callerOwned = { nested: ['captured'] }
        const writing = mutatePersistentPluginStorage(
            'pluginsave/YWxwaGE.json',
            'set',
            callerOwned,
            'Plugin',
        )
        callerOwned.nested[0] = 'mutated-after-call'
        await expect(writing).resolves.toMatchObject({ outcome: 'committed' })

        expect(storage.mutatePluginStorage).toHaveBeenCalledOnce()
        const request = storage.mutatePluginStorage.mock.calls[0][0]
        expect(request.valueKey).toBe('pluginsave/YWxwaGE.json')
        expect(request.owner).toBe('Plugin')
        expect(JSON.parse(new TextDecoder().decode(request.valueBytes))).toEqual({
            nested: ['captured'],
        })
    })

    it.each(['not-committed', 'unknown'] as const)(
        'rejects with the structured %s result',
        async (outcome) => {
            storage.mutatePluginStorage.mockResolvedValueOnce({
                outcome,
                operation: 'remove',
                code: 'INJECTED',
                error: 'injected outcome',
            })

            await expect(mutatePersistentPluginStorage(
                'pluginsave/YWxwaGE.json',
                'remove',
            )).rejects.toMatchObject({
                name: 'PluginStorageMutationError',
                result: { outcome, code: 'INJECTED' },
            })
        },
    )
})

describe('persistent JSON preparation', () => {
    it('measures exact UTF-8 bytes for non-ASCII plugin payloads', () => {
        const value = { vector: [1, 2, 3], media: '😀한글'.repeat(500) }
        const expected = Buffer.from(JSON.stringify(value), 'utf8')
        const prepared = preparePersistentJson(value, { pluginValue: true })

        expect(prepared.byteLength).toBe(expected.byteLength)
        expect(Buffer.from(prepared.bytes)).toEqual(expected)
    })

    it('does not invoke toJSON and rejects values with no JSON representation', () => {
        let calls = 0
        expect(() => preparePersistentJson({
            toJSON() {
                calls += 1
                return { stable: true }
            },
        }, { pluginValue: true })).toThrow(TypeError)

        expect(calls).toBe(0)
        expect(() => preparePersistentJson(undefined, { pluginValue: true }))
            .toThrow(TypeError)
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
