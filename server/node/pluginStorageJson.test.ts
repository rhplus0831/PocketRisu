import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    PluginStorageValidationError,
    createPluginStorageOwnerScanner,
    parsePluginStorageJsonBuffer,
    snapshotPluginStorageRecord,
    snapshotPluginStorageJson,
    stringifyPluginStorageJson,
    validatePluginStorageRow,
} = require('./pluginStorageJson.cjs') as {
    PluginStorageValidationError: new (encodedKey: string) => Error & {
        code: string
        encodedKey: string
    }
    createPluginStorageOwnerScanner: (options?: { maxCaptureBytes?: number }) => {
        push: (bytes: Uint8Array) => void
        finish: () => string | null
    }
    parsePluginStorageJsonBuffer: (value: Uint8Array, key?: string) => unknown
    snapshotPluginStorageRecord: (
        value: unknown,
        fieldName: string,
        prefix: string,
    ) => Record<string, unknown>
    snapshotPluginStorageJson: (value: unknown) => unknown
    stringifyPluginStorageJson: (value: unknown) => string
    validatePluginStorageRow: (key: string, value: Uint8Array) => unknown
}

const encoded = (key: string) => `pluginsave/${Buffer.from(key).toString('base64url')}.json`

describe('plugin storage JSON server boundary', () => {
    it('extracts the last top-level plugin owner across bounded pages', () => {
        const body = Buffer.from(
            '{"nested":{"plugin":"nested-must-not-win"},'
            + '"plugin":"초기 owner","array":[{"plugin":"also-nested"}],'
            + '"pl\\u0075gin":"최종 owner 🔑"}',
        )
        const scanner = createPluginStorageOwnerScanner()
        for (let offset = 0; offset < body.length; offset += 3) {
            scanner.push(body.subarray(offset, offset + 3))
        }
        expect(scanner.finish()).toBe('최종 owner 🔑')
    })

    it('omits invalid or implausibly large best-effort owner names', () => {
        const nonString = createPluginStorageOwnerScanner()
        nonString.push(Buffer.from('{"plugin":"first","plugin":42}'))
        expect(nonString.finish()).toBeNull()

        const oversized = createPluginStorageOwnerScanner({ maxCaptureBytes: 4 })
        oversized.push(Buffer.from('{"plugin":"12345"}'))
        expect(oversized.finish()).toBeNull()
    })

    it('accepts and detaches the same strict JSON value set as the client', () => {
        const source = { nested: ['safe', -0], ['__proto__']: { own: true } }
        const json = stringifyPluginStorageJson(source)
        source.nested[0] = 'mutated'

        expect(JSON.parse(json)).toEqual({
            nested: ['safe', 0],
            ['__proto__']: { own: true },
        })
        expect(validatePluginStorageRow(encoded('valid'), Buffer.from(json)))
            .toEqual({
                nested: ['safe', 0],
                ['__proto__']: { own: true },
            })
    })

    it.each([
        ['zero-length', Buffer.alloc(0)],
        ['malformed', Buffer.from('{"unfinished":')],
        ['invalid UTF-8', Buffer.from([0xff])],
    ])('rejects %s rows before ingest', (_name, bytes) => {
        const key = encoded('suspect')
        expect(() => validatePluginStorageRow(key, bytes)).toThrow(expect.objectContaining({
            name: 'PluginStorageValidationError',
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: key,
            message: 'Invalid plugin storage JSON row',
        }))
    })

    it('rejects non-canonical encoded keys before ingest', () => {
        expect(() => validatePluginStorageRow('pluginsave/=.json', Buffer.from('1')))
            .toThrow(expect.objectContaining({
                code: 'INVALID_PLUGIN_STORAGE_ROW',
                encodedKey: 'pluginsave/',
                message: 'Invalid plugin storage JSON row',
            }))
    })

    it('rejects accessors without invoking them', () => {
        let getterCalls = 0
        const value = {}
        Object.defineProperty(value, 'secret', {
            enumerable: true,
            get: () => {
                getterCalls += 1
                return 'must-not-read'
            },
        })

        expect(() => snapshotPluginStorageJson(value)).toThrow(TypeError)
        expect(getterCalls).toBe(0)
    })

    it.each([
        new Map([['lost', true]]),
        { nested: undefined },
        { nested: Number.POSITIVE_INFINITY },
    ])('rejects unsupported values instead of lossy JSON coercion', value => {
        expect(() => stringifyPluginStorageJson(value)).toThrow(TypeError)
    })

    it('returns no row validation for unrelated generic KV namespaces', () => {
        expect(validatePluginStorageRow('drafts/key', Buffer.alloc(0))).toBeNull()
        expect(() => parsePluginStorageJsonBuffer(Buffer.alloc(0)))
            .toThrow(SyntaxError)
    })

    it('reduces hostile record traps to prefix-only diagnostics', () => {
        const secret = 'SECRET_FROM_PROXY_TRAP'
        const source = new Proxy({}, {
            ownKeys: () => {
                throw new Error(secret)
            },
        })

        let caught: unknown
        try {
            snapshotPluginStorageRecord(source, 'pluginCustomStorage', 'pluginsave/')
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(PluginStorageValidationError)
        expect(caught).toMatchObject({
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: 'pluginsave/',
            message: 'Invalid plugin storage JSON row',
        })
        expect(String(caught)).not.toContain(secret)
    })

    it('reports hostile row values by encoded key without decoded keys or values', () => {
        const decodedKey = 'decoded/private-plugin-key'
        const secret = 'SECRET_FROM_ROW_VALUE'
        const hostileValue = new Proxy({}, {
            getPrototypeOf: () => {
                throw new Error(secret)
            },
        })
        const source = { [decodedKey]: hostileValue }

        let caught: unknown
        try {
            snapshotPluginStorageRecord(source, 'pluginCustomStorage', 'pluginsave/')
        } catch (error) {
            caught = error
        }

        expect(caught).toMatchObject({
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: encoded(decodedKey),
            message: 'Invalid plugin storage JSON row',
        })
        const diagnostic = JSON.stringify(caught)
        expect(diagnostic).not.toContain(decodedKey)
        expect(diagnostic).not.toContain(secret)
    })
})
