import { describe, expect, it, vi } from 'vitest'
import generationMemoPkg from './generationMemo.cjs'

const { createGenerationMemo } = generationMemoPkg as {
    createGenerationMemo: () => {
        bump: (key: string) => number
        getOrCompute: <T>(key: string, name: string, compute: () => T) => T
        seed: <T>(key: string, name: string, value: T) => void
        deleteValue: (key: string, name: string, expectedGeneration?: number) => boolean
        has: (key: string, name: string) => boolean
        generation: (key: string) => number
    }
}

describe('mutation-generation derived value memo', () => {
    it('computes each derived value once per file generation', () => {
        const memo = createGenerationMemo()
        const computeHash = vi.fn(() => 'hash-1')
        const computeEtag = vi.fn(() => 'etag-1')

        memo.bump('database')
        expect(memo.getOrCompute('database', 'hash', computeHash)).toBe('hash-1')
        expect(memo.getOrCompute('database', 'hash', computeHash)).toBe('hash-1')
        expect(memo.getOrCompute('database', 'etag', computeEtag)).toBe('etag-1')
        expect(memo.getOrCompute('database', 'etag', computeEtag)).toBe('etag-1')
        expect(computeHash).toHaveBeenCalledTimes(1)
        expect(computeEtag).toHaveBeenCalledTimes(1)

        memo.bump('database')
        expect(memo.generation('database')).toBe(2)
        expect(memo.getOrCompute('database', 'hash', () => 'hash-2')).toBe('hash-2')
        expect(memo.getOrCompute('database', 'etag', () => 'etag-2')).toBe('etag-2')
    })

    it('keeps file paths independent and supports seeding an already-computed value', () => {
        const memo = createGenerationMemo()
        const unexpectedCompute = vi.fn(() => 'wrong')

        memo.bump('database')
        memo.bump('plugin')
        memo.seed('database', 'etag', 'prepared-etag')

        expect(memo.getOrCompute('database', 'etag', unexpectedCompute)).toBe('prepared-etag')
        expect(unexpectedCompute).not.toHaveBeenCalled()
        expect(memo.getOrCompute('plugin', 'etag', () => 'plugin-etag')).toBe('plugin-etag')

        memo.bump('database')
        expect(memo.getOrCompute('database', 'etag', () => 'fresh-etag')).toBe('fresh-etag')
        expect(memo.getOrCompute('plugin', 'etag', unexpectedCompute)).toBe('plugin-etag')
        expect(unexpectedCompute).not.toHaveBeenCalled()
    })

    it('releases one derived value only for the generation that retained it', () => {
        const memo = createGenerationMemo()
        memo.bump('database')
        const retainedGeneration = memo.generation('database')
        memo.seed('database', 'canonical-encoding', Buffer.from('generation-1'))
        memo.seed('database', 'etag', 'etag-1')

        expect(memo.has('database', 'canonical-encoding')).toBe(true)
        expect(memo.deleteValue('database', 'canonical-encoding', retainedGeneration)).toBe(true)
        expect(memo.has('database', 'canonical-encoding')).toBe(false)
        expect(memo.has('database', 'etag')).toBe(true)

        memo.seed('database', 'canonical-encoding', Buffer.from('generation-1-retry'))
        memo.bump('database')
        memo.seed('database', 'canonical-encoding', Buffer.from('generation-2'))

        expect(memo.deleteValue('database', 'canonical-encoding', retainedGeneration)).toBe(false)
        expect(memo.has('database', 'canonical-encoding')).toBe(true)
    })
})
