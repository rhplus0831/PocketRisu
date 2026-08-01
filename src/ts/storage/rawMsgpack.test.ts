import { describe, expect, test } from 'vitest'
import { decodeRawMsgpack, encodeRawMsgpack } from './rawMsgpack'

describe('raw MessagePack codec', () => {
    test('round-trips a standard map above the map16 key ceiling', () => {
        const keyCount = 65_536
        const wide = Object.fromEntries(
            Array.from({ length: keyCount }, (_, index) => [`key-${index}`, index]),
        )

        const decoded = decodeRawMsgpack(encodeRawMsgpack({ wide }))
        expect(Object.keys(decoded.wide)).toHaveLength(keyCount)
        expect(decoded.wide['key-65535']).toBe(65_535)
    })

    test('copies decoded binary fields away from their source segment', () => {
        const encoded = encodeRawMsgpack({ binary: new Uint8Array([1, 2, 3, 4]) })
        const decoded = decodeRawMsgpack(encoded)

        expect(Array.from(decoded.binary)).toEqual([1, 2, 3, 4])
        expect(decoded.binary.buffer).not.toBe(encoded.buffer)
    })
})
