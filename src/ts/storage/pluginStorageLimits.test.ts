import { describe, expect, test } from 'vitest'
import {
    DEFAULT_PLUGIN_VALUE_MAX_BYTES,
    parsePluginStorageCapabilities,
    pluginStorageLimitMessage,
} from './pluginStorageLimits'

describe('plugin storage limit negotiation', () => {
    test('accepts a positive safe configured limit', () => {
        expect(parsePluginStorageCapabilities({ maxValueBytes: 256 * 1024 * 1024 }))
            .toEqual({ maxValueBytes: 256 * 1024 * 1024 })
    })

    test.each([
        null,
        {},
        { maxValueBytes: 0 },
        { maxValueBytes: -1 },
        { maxValueBytes: 1.5 },
        { maxValueBytes: Number.MAX_SAFE_INTEGER + 1 },
        { maxValueBytes: '134217728' },
    ])('rejects a malformed capability: %j', capability => {
        expect(parsePluginStorageCapabilities(capability)).toBeNull()
    })

    test('keeps the historical ceiling as the legacy-server fallback', () => {
        expect(DEFAULT_PLUGIN_VALUE_MAX_BYTES).toBe(128 * 1024 * 1024)
        expect(pluginStorageLimitMessage(9, 8)).toContain('limit is 8 bytes')
    })
})
