import { describe, expect, it } from 'vitest'
import utilsPkg from './utils.cjs'

const { parseCachedHashesHeader, sha256Hex } = utilsPkg as {
    parseCachedHashesHeader: (value: unknown) => string[]
    sha256Hex: (value: string | Buffer | Uint8Array) => string
}

describe('resource cache wire helpers', () => {
    it('accepts trimmed lowercase SHA-256 hashes and drops malformed entries', () => {
        const a = 'a'.repeat(64)
        const b = '0123456789abcdef'.repeat(4)

        expect(parseCachedHashesHeader(` ${a},invalid,${b},${a},${'A'.repeat(64)} `)).toEqual([
            a,
            b,
        ])
        expect(parseCachedHashesHeader(undefined)).toEqual([])
        expect(parseCachedHashesHeader(['a'.repeat(64)])).toEqual([])
    })

    it('considers at most the first eight comma-separated entries', () => {
        const hashes = Array.from({ length: 9 }, (_, index) => index.toString(16).padStart(64, '0'))

        expect(parseCachedHashesHeader(hashes.join(','))).toEqual(hashes.slice(0, 8))
    })

    it('hashes the exact supplied bytes as lowercase SHA-256 hex', () => {
        expect(sha256Hex(Buffer.from('hello'))).toBe(
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        )
        expect(sha256Hex(new Uint8Array([0, 255, 1]))).toMatch(/^[0-9a-f]{64}$/)
        expect(sha256Hex(new Uint8Array([0, 255, 1]))).not.toBe(sha256Hex(new Uint8Array([0, 255, 2])))
    })
})
