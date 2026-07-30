import { describe, expect, it } from 'vitest'
import pluginSaveKeysPkg from './pluginSaveKeys.cjs'

const {
    BACKUP_ENTRY_NAME_MAX_BYTES,
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_ILL_FORMED_UTF16_TAG,
    PLUGIN_STORAGE_MANIFEST_VERSION,
    createPluginStorageManifest,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
    parsePluginStorageManifest,
} = pluginSaveKeysPkg as {
    BACKUP_ENTRY_NAME_MAX_BYTES: number
    PLUGIN_SAVE_PREFIX: string
    PLUGIN_SAVE_META_PREFIX: string
    PLUGIN_SAVE_ILL_FORMED_UTF16_TAG: string
    PLUGIN_STORAGE_MANIFEST_VERSION: number
    createPluginStorageManifest: (
        generation: string,
        valueKeys: Iterable<string>,
        metaKeys: Iterable<string>,
    ) => { version: number, generation: string, valueKeys: string[], metaKeys: string[] }
    decodePluginSaveStorageKey: (storageKey: string, prefix: string) => string
    encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
    parsePluginStorageManifest: (value: unknown) => {
        version: number, generation: string, valueKeys: string[], metaKeys: string[]
    } | null
}

describe('plugin save storage keys', () => {
    it('losslessly separates historical lone surrogates from valid Unicode', () => {
        const keys = ['\uD800', '\uD801', '\uDC00', '�'].map(rawKey => (
            encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_PREFIX)
        ))

        expect(new Set(keys).size).toBe(keys.length)
        expect(keys[0]).toContain(`/${PLUGIN_SAVE_ILL_FORMED_UTF16_TAG}`)
        expect(keys[3]).not.toContain(`/${PLUGIN_SAVE_ILL_FORMED_UTF16_TAG}`)
        for (let index = 0; index < keys.length; index += 1) {
            expect(decodePluginSaveStorageKey(keys[index], PLUGIN_SAVE_PREFIX))
                .toBe(['\uD800', '\uD801', '\uDC00', '�'][index])
        }
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
        expect(() => decodePluginSaveStorageKey(
            `pluginsave/${PLUGIN_SAVE_ILL_FORMED_UTF16_TAG}AGE.json`,
            PLUGIN_SAVE_PREFIX,
        )).toThrow('Non-canonical plugin storage key')
    })

    it('enforces exact value and metadata archive-name boundaries', () => {
        const maxValueName = encodePluginSaveStorageKey('v'.repeat(756), PLUGIN_SAVE_PREFIX)
        const maxMetaName = encodePluginSaveStorageKey('m'.repeat(752), PLUGIN_SAVE_META_PREFIX)

        expect(Buffer.byteLength(maxValueName, 'utf-8')).toBe(BACKUP_ENTRY_NAME_MAX_BYTES)
        expect(Buffer.byteLength(maxMetaName, 'utf-8')).toBe(BACKUP_ENTRY_NAME_MAX_BYTES)
        expect(() => encodePluginSaveStorageKey('v'.repeat(757), PLUGIN_SAVE_PREFIX))
            .toThrow('too long for backup archives')
        expect(() => encodePluginSaveStorageKey('m'.repeat(753), PLUGIN_SAVE_META_PREFIX))
            .toThrow('too long for backup archives')
    })

    it('uses encoded UTF-8 bytes for non-ASCII raw keys', () => {
        const maxUtf8Key = 'é'.repeat(376)
        expect(Buffer.byteLength(maxUtf8Key, 'utf-8')).toBe(752)
        expect(() => encodePluginSaveStorageKey(maxUtf8Key, PLUGIN_SAVE_META_PREFIX))
            .not.toThrow()
        expect(() => encodePluginSaveStorageKey(`${maxUtf8Key}a`, PLUGIN_SAVE_META_PREFIX))
            .toThrow('too long for backup archives')
    })

    it('accepts a version-one order baseline and creates authoritative version-two order', () => {
        const valueKeys = ['z', 'a'].map(key => encodePluginSaveStorageKey(key, PLUGIN_SAVE_PREFIX))
        const legacy = parsePluginStorageManifest({
            version: 1,
            generation: 'legacy-generation',
            valueKeys,
            metaKeys: [],
        })

        expect(legacy).toEqual({
            version: 1,
            generation: 'legacy-generation',
            valueKeys,
            metaKeys: [],
        })
        expect(PLUGIN_STORAGE_MANIFEST_VERSION).toBe(2)
        expect(createPluginStorageManifest('ordered-generation', valueKeys, [])).toEqual({
            version: 2,
            generation: 'ordered-generation',
            valueKeys,
            metaKeys: [],
        })
    })
})
