import { describe, expect, it } from 'vitest'
import cachePkg from './pluginStorageManifestCache.cjs'
import keysPkg from './pluginSaveKeys.cjs'

const { createPluginStorageManifestCache } = cachePkg as any
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    createPluginStorageManifest,
    encodePluginSaveStorageKey,
} = keysPkg as any

function state(manifest: any, revision: string | null = 'sha256:manifest') {
    return { manifest, present: manifest !== null, valid: true, revision }
}

describe('revision-bound parsed plugin manifest cache', () => {
    it('parses and derives membership once within an exact revision', () => {
        let revision = 4
        let reads = 0
        const manifest = createPluginStorageManifest('generation-a', [
            encodePluginSaveStorageKey('a', PLUGIN_SAVE_PREFIX),
        ], [])
        const cache = createPluginStorageManifestCache({
            getRevision: () => revision,
            readState: () => {
                reads += 1
                return state(manifest)
            },
        })

        const first = cache.read()
        const second = cache.read()
        expect(second).toBe(first)
        expect(second.valueKeys.has(manifest.valueKeys[0])).toBe(true)
        expect(reads).toBe(1)
        expect(cache.counters()).toMatchObject({ hits: 1, misses: 1 })

        revision += 1
        expect(cache.read()).not.toBe(first)
        expect(reads).toBe(2)
        expect(cache.counters().revisionChanges).toBe(1)
    })

    it('fails closed across generation writes, transitions, and destructive restores', () => {
        let revision = 1
        let current = state(createPluginStorageManifest('generation-a', [], []), 'sha256:a')
        let reads = 0
        const cache = createPluginStorageManifestCache({
            getRevision: () => revision,
            readState: () => {
                reads += 1
                return current
            },
        })

        expect(cache.read().state.manifest.generation).toBe('generation-a')

        // A full database generation write changes the shared publication clock.
        revision += 1
        current = state(createPluginStorageManifest('generation-b', [], []), 'sha256:b')
        expect(cache.read().state.manifest.generation).toBe('generation-b')

        // Internalization removes the manifest.
        revision += 1
        current = state(null, null)
        expect(cache.read().state).toEqual({
            manifest: null,
            present: false,
            valid: true,
            revision: null,
        })

        // A destructive restore can republish an older generation and exact manifest.
        revision += 1
        current = state(createPluginStorageManifest('generation-restored', [], []), 'sha256:r')
        expect(cache.read().state.manifest.generation).toBe('generation-restored')
        expect(reads).toBe(4)
        expect(cache.counters().revisionChanges).toBe(3)
    })

    it('never caches a read whose authoritative revision cannot be verified', () => {
        let revision: number | null = null
        let reads = 0
        const cache = createPluginStorageManifestCache({
            getRevision: () => revision,
            readState: () => {
                reads += 1
                return state(null, null)
            },
        })

        cache.read()
        cache.read()
        expect(reads).toBe(2)
        revision = Number.MAX_SAFE_INTEGER + 1
        cache.read()
        cache.read()
        expect(reads).toBe(4)
        revision = 1
        cache.read()
        cache.read()
        expect(reads).toBe(5)
    })

    it('publishes one-key deltas without re-reading or re-deriving the manifest indexes', () => {
        let revision = 7
        let reads = 0
        const longRawKey = `cache/${'long-key-'.repeat(600)}`
        const hashedValueKey = encodePluginSaveStorageKey(longRawKey, PLUGIN_SAVE_PREFIX)
        const hashedOwnerKey = encodePluginSaveStorageKey(longRawKey, PLUGIN_SAVE_META_PREFIX)
        const ordinaryKey = encodePluginSaveStorageKey('ordinary', PLUGIN_SAVE_PREFIX)
        const manifest = createPluginStorageManifest(
            'generation-a',
            [hashedValueKey],
            [hashedOwnerKey],
            [[hashedValueKey.slice(PLUGIN_SAVE_PREFIX.length), longRawKey]],
        )
        const cache = createPluginStorageManifestCache({
            getRevision: () => revision,
            readState: () => {
                reads += 1
                return state(manifest)
            },
        })
        const entry = cache.read()
        const mappingArray = entry.state.manifest.keyMappings
        const prepared = cache.prepareUpdate(entry, { valueAdds: [ordinaryKey] })

        expect(prepared.manifest.valueKeys).toEqual([hashedValueKey, ordinaryKey])
        expect(prepared.manifest.keyMappings).toBe(mappingArray)
        revision += 1
        cache.publishPrepared(prepared, {
            revision,
            manifestRevision: 'sha256:next',
        })
        const published = cache.read()
        expect(published).toBe(entry)
        expect(published.valueKeys.has(ordinaryKey)).toBe(true)
        expect(published.mappingByComponent.get(
            hashedValueKey.slice(PLUGIN_SAVE_PREFIX.length),
        )).toBe(longRawKey)
        expect(published.state.revision).toBe('sha256:next')
        expect(reads).toBe(1)
    })
})
