import { describe, expect, it, vi } from 'vitest'
import boundedSessionStatePkg from './boundedSessionState.cjs'

const { createBoundedSessionState } = boundedSessionStatePkg as any

describe('bounded per-session state', () => {
    it('evicts the least-recently-used session at the configured bound', () => {
        const onEvict = vi.fn()
        const state = createBoundedSessionState({ maxEntries: 3, onEvict })
        state.set('active', { generation: 'g1' })
        state.set('old', { generation: 'g1' })
        state.set('recent', { generation: 'g1' })

        expect(state.get('active')).toEqual({ generation: 'g1' })
        state.set('new', { generation: 'g1' })

        expect(state.get('old')).toBeNull()
        expect(state.get('active')).toEqual({ generation: 'g1' })
        expect(onEvict).toHaveBeenCalledWith('old', { generation: 'g1' })
        expect(state.stats()).toMatchObject({ maxEntries: 3, size: 3, evictions: 1 })
    })

    it('treats an evicted session as fresh until its next database read re-pins it', () => {
        const state = createBoundedSessionState({ maxEntries: 2 })
        state.set('session-a', { optimized: true, generation: 'old' })
        state.set('session-b', { optimized: true, generation: 'current' })
        state.set('session-c', { optimized: true, generation: 'current' })

        expect(state.get('session-a')).toBeNull()
        state.set('session-a', { optimized: true, generation: 'current' })
        expect(state.get('session-a')).toEqual({ optimized: true, generation: 'current' })
        expect(state.stats()).toMatchObject({ size: 2, evictions: 2 })
    })
})
