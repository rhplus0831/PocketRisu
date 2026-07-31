import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
    PluginStorageValidationError,
    convertCompatiblePluginStorageJson,
    createPluginStorageOwnerScanner,
    encodeValidatedPluginStorageKey,
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
    convertCompatiblePluginStorageJson: (value: unknown) => unknown
    createPluginStorageOwnerScanner: (options?: { maxCaptureBytes?: number }) => {
        push: (bytes: Uint8Array) => void
        finish: () => string | null
    }
    encodeValidatedPluginStorageKey: (rawKey: string, prefix: string) => string
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

    it('snapshots distinct malformed UTF-16 keys without poisoning valid rows', () => {
        const rawKeys = ['\uD800', '\uD801', '�', 'valid']
        const source = Object.fromEntries(rawKeys.map((key, index) => [key, { index }]))

        const snapshot = snapshotPluginStorageRecord(
            source,
            'pluginCustomStorage',
            'pluginsave/',
        )
        const storageKeys = rawKeys.map(key => (
            encodeValidatedPluginStorageKey(key, 'pluginsave/')
        ))

        expect(Reflect.ownKeys(snapshot)).toEqual(rawKeys)
        expect(new Set(storageKeys).size).toBe(rawKeys.length)
        expect(storageKeys.slice(0, 2).every(key => key.includes('/utf16-v1.'))).toBe(true)
        expect(validatePluginStorageRow(storageKeys[0], Buffer.from('{"legacy":true}')))
            .toEqual({ legacy: true })
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

    it('converts the documented rich-value subset on the server', () => {
        const sparse = new Array(3)
        sparse[1] = Number.NaN
        expect(convertCompatiblePluginStorageJson({
            date: new Date('2026-01-02T03:04:05.000Z'),
            map: new Map([[1n, new Set(['a', 'b'])]]),
            bigint: -42n,
            missing: undefined,
            sparse,
        })).toEqual({
            date: '2026-01-02T03:04:05.000Z',
            map: [['1', ['a', 'b']]],
            bigint: '-42',
            missing: null,
            sparse: [null, null, null],
        })
    })

    it('keeps functions and circular references outside automatic conversion', () => {
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        expect(() => convertCompatiblePluginStorageJson(() => undefined)).toThrow(TypeError)
        expect(() => convertCompatiblePluginStorageJson(cycle)).toThrow(TypeError)
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
