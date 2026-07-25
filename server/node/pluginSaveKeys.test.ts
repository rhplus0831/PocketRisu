import { describe, expect, it } from 'vitest'
import pluginSaveKeysPkg from './pluginSaveKeys.cjs'

const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
} = pluginSaveKeysPkg as {
    PLUGIN_SAVE_PREFIX: string
    PLUGIN_SAVE_META_PREFIX: string
    decodePluginSaveStorageKey: (storageKey: string, prefix: string) => string
    encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
}

describe('plugin save storage keys', () => {
    it('rejects lone surrogates before UTF-8 encoding', () => {
        expect(() => encodePluginSaveStorageKey('\uD800', PLUGIN_SAVE_PREFIX))
            .toThrow('well-formed Unicode')
        expect(() => encodePluginSaveStorageKey('\uD801', PLUGIN_SAVE_META_PREFIX))
            .toThrow('well-formed Unicode')
    })

    it.each([
        ['normal key', PLUGIN_SAVE_PREFIX],
        ['�', PLUGIN_SAVE_PREFIX],
        ['키🔑', PLUGIN_SAVE_META_PREFIX],
    ])('round-trips the well-formed key %j', (rawKey, prefix) => {
        const storageKey = encodePluginSaveStorageKey(rawKey, prefix)
        expect(decodePluginSaveStorageKey(storageKey, prefix)).toBe(rawKey)
    })

    it('continues to reject non-canonical encoded forms', () => {
        expect(() => decodePluginSaveStorageKey('pluginsave/_w.json', PLUGIN_SAVE_PREFIX))
            .toThrow('Non-canonical plugin storage key')
    })
})
