import { describe, expect, it, vi } from 'vitest'
import cachePkg from './revisionBoundCache.cjs'

const { createRevisionBoundCache } = cachePkg as any

describe('revision-bound decoded cache', () => {
    it('reuses only clean entries from the matching authoritative revision', () => {
        const mutations = vi.fn()
        const cache = createRevisionBoundCache({ onMutation: mutations })
        const value = { database: 1 }

        cache.set('database', value, { revision: 4, estimatedBytes: 20, dirty: false })
        expect(cache.getForRevision('database', 4)).toBe(value)
        expect(cache.getForRevision('database', 5)).toBeUndefined()
        expect(cache.has('database')).toBe(false)
        expect(mutations).toHaveBeenLastCalledWith('database', 'stale-revision')
    })

    it('pins dirty entries across entry, byte, and memory-pressure eviction', () => {
        let pressure = false
        const cache = createRevisionBoundCache({
            maxEntries: 1,
            maxEstimatedBytes: 10,
            maxEntryEstimatedBytes: 8,
            isUnderMemoryPressure: () => pressure,
        })
        const dirty = { acknowledged: true }
        cache.set('dirty', dirty, { revision: 1, estimatedBytes: 100, dirty: true })
        cache.set('clean', { disposable: true }, { revision: 1, estimatedBytes: 20, dirty: false })

        expect(cache.prune()).toEqual(['clean'])
        expect(cache.peek('dirty')).toBe(dirty)
        pressure = true
        expect(cache.prune()).toEqual([])
        expect(cache.peek('dirty')).toBe(dirty)
    })

    it('can read matching dirty state without discarding it on a mismatch', () => {
        const cache = createRevisionBoundCache()
        const dirty = { acknowledged: true }
        cache.set('database', dirty, { revision: 7, dirty: true })

        expect(cache.getForRevision('database', 7)).toBeUndefined()
        expect(cache.getForRevision('database', 7, { allowDirty: true })).toBe(dirty)
        expect(cache.getForRevision('database', 8, { allowDirty: true })).toBeUndefined()
        expect(cache.peek('database')).toBe(dirty)
    })

    it('evicts least-recently-used clean entries to the aggregate budget', () => {
        let clock = 0
        const cache = createRevisionBoundCache({
            maxEntries: 2,
            maxEstimatedBytes: 20,
            maxEntryEstimatedBytes: 20,
            now: () => ++clock,
        })
        cache.set('old', {}, { revision: 1, estimatedBytes: 10 })
        cache.set('recent', {}, { revision: 1, estimatedBytes: 10 })
        cache.get('old')
        cache.set('new', {}, { revision: 1, estimatedBytes: 10 })

        expect(cache.prune()).toEqual(['recent'])
        expect(cache.keys()).toEqual(['old', 'new'])
        expect(cache.estimatedBytes()).toBe(20)
    })

    it('allows a persisted dirty entry to become evictable with its new revision', () => {
        const cache = createRevisionBoundCache({ maxEstimatedBytes: 4 })
        const value = { pending: true }
        cache.set('database', value, { revision: 2, estimatedBytes: 10, dirty: true })

        expect(cache.prune()).toEqual([])
        expect(cache.markClean('database', { revision: 3, estimatedBytes: 10 })).toBe(true)
        expect(cache.getForRevision('database', 3)).toBe(value)
        expect(cache.prune()).toEqual(['database'])
    })
})
