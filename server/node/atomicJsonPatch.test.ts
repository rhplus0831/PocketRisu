import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import jsonPatchPkg from 'fast-json-patch'
import atomicPatchPkg from './atomicJsonPatch.cjs'

const require = createRequire(import.meta.url)
const { applyPatch } = jsonPatchPkg
const { applyPatchAtomic } = atomicPatchPkg as {
    applyPatchAtomic: (document: unknown, patch: unknown[]) => Array<unknown> & { newDocument: any }
}
const { calculateHash } = require('./utils.cjs') as {
    calculateHash: (value: unknown, memo?: WeakMap<object, number>) => number
}

function jsonClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
}

describe('atomic structural-sharing JSON Patch', () => {
    it('matches fast-json-patch across object, array, append, copy, move, and test operations', () => {
        const original = {
            profile: { name: 'Risu', flags: { old: true, kept: true } },
            items: [
                { id: 'a', value: 1 },
                { id: 'b', value: 2 },
            ],
            source: { deep: { answer: 42 } },
            untouched: { payload: ['shared', 'branch'] },
        }
        const patch = [
            { op: 'test', path: '/profile/name', value: 'Risu' },
            { op: 'add', path: '/items/-', value: { id: 'c', value: 3 } },
            { op: 'replace', path: '/items/0/id', value: 'updated' },
            { op: 'copy', from: '/source', path: '/copied' },
            { op: 'move', from: '/items/1', path: '/items/0' },
            { op: 'remove', path: '/profile/flags/old' },
            { op: 'add', path: '/profile/new~1field', value: 'escaped' },
        ]

        const expected = applyPatch(jsonClone(original), jsonClone(patch), true).newDocument
        const result = applyPatchAtomic(original, patch)

        expect(result.newDocument).toEqual(expected)
        expect(result).toHaveLength(patch.length)
        expect(result.newDocument).not.toBe(original)
        expect(result.newDocument.profile).not.toBe(original.profile)
        expect(result.newDocument.items).not.toBe(original.items)
        expect(result.newDocument.untouched).toBe(original.untouched)
    })

    it('leaves the original graph byte-for-byte and reference-for-reference intact when a later op throws', () => {
        const original = {
            characters: [{ name: 'before', chats: [{ id: 'chat', _stub: true }] }],
            untouched: { large: [1, 2, 3] },
        }
        const before = jsonClone(original)
        const originalCharacter = original.characters[0]
        const originalChat = original.characters[0].chats[0]

        expect(() => applyPatchAtomic(original, [
            { op: 'replace', path: '/characters/0/name', value: 'after' },
            { op: 'remove', path: '/characters/0/missing/value' },
        ])).toThrow()

        expect(original).toEqual(before)
        expect(original.characters[0]).toBe(originalCharacter)
        expect(original.characters[0].chats[0]).toBe(originalChat)
    })

    it('keeps root copy/move results private from the source graph', () => {
        for (const op of ['copy', 'move']) {
            const original = {
                nested: { child: { value: 1 }, shared: { value: 2 } },
                elsewhere: true,
            }
            const patch = [
                { op, from: '/nested', path: '' },
                { op: 'replace', path: '/child/value', value: 99 },
            ]
            const expected = applyPatch(jsonClone(original), jsonClone(patch), true).newDocument

            const result = applyPatchAtomic(original, patch)

            expect(result.newDocument).toEqual(expected)
            expect(original.nested.child.value).toBe(1)
            expect(result.newDocument.shared).not.toBe(original.nested.shared)
        }
    })

    it('does not manufacture a mutation for a test-only patch', () => {
        const original = { value: { nested: true } }
        const result = applyPatchAtomic(original, [
            { op: 'test', path: '/value/nested', value: true },
        ])

        expect(result.newDocument).toBe(original)
    })

    it('reuses exact hashes for unchanged copy-on-write branches', () => {
        let unchangedReads = 0
        const unchanged = {
            get payload() {
                unchangedReads += 1
                return ['large', 'shared', 'branch']
            },
        }
        const original = {
            changed: { value: 1 },
            unchanged,
        }
        const memo = new WeakMap<object, number>()

        calculateHash(original, memo)
        expect(unchangedReads).toBe(1)

        const patched = applyPatchAtomic(original, [
            { op: 'replace', path: '/changed/value', value: 2 },
        ]).newDocument
        const memoizedHash = calculateHash(patched, memo)

        expect(patched.unchanged).toBe(unchanged)
        expect(unchangedReads).toBe(1)
        expect(memoizedHash).toBe(calculateHash(jsonClone(patched)))
    })
})
