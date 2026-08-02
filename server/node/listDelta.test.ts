import { describe, expect, it, vi } from 'vitest'
import pkg from './listDelta.cjs'

const {
    LIST_DELTA_MAX_AGE_MS,
    MAX_INLAY_DELTA_STAT_ENTRIES,
    buildListResponse,
    canUseListDelta,
} = pkg as {
    LIST_DELTA_MAX_AGE_MS: number
    MAX_INLAY_DELTA_STAT_ENTRIES: number
    canUseListDelta: (options: {
        lastSync: number
        clientEpoch: string
        serverEpoch: string
        now: number
    }) => boolean
    buildListResponse: (options: ListOptions) => Promise<Record<string, any>>
}

interface ListOptions {
    keyPrefix: string
    lastSync: number
    clientEpoch: string
    serverEpoch: string
    now: number
    listKv: (prefix?: string) => string[]
    listModifiedKv: (since: number, prefix?: string) => string[]
    listDeletedKv: (since: number, prefix?: string) => string[]
    listAssetEntries: () => Array<{
        key: string
        source: 'fs' | 'kv'
        mtimeMs: number | null
    }>
    listInlayEntries: () => Promise<Array<{ id: string; filePath: string }>>
    statFile: (filePath: string) => Promise<{ mtimeMs: number }>
    maxInlayDeltaStatEntries?: number
}

function options(overrides: Partial<ListOptions> = {}): ListOptions {
    return {
        keyPrefix: '',
        lastSync: 5_000,
        clientEpoch: 'epoch-a',
        serverEpoch: 'epoch-a',
        now: 10_000,
        listKv: vi.fn(() => ['kv/live']),
        listModifiedKv: vi.fn(() => ['kv/added']),
        listDeletedKv: vi.fn(() => ['kv/deleted']),
        listAssetEntries: vi.fn(() => []),
        listInlayEntries: vi.fn(async () => []),
        statFile: vi.fn(async () => ({ mtimeMs: 0 })),
        ...overrides,
    }
}

describe('delta list response', () => {
    it('requires a current timestamp and matching epoch', () => {
        expect(canUseListDelta({ lastSync: 5_000, clientEpoch: 'a', serverEpoch: 'a', now: 10_000 })).toBe(true)
        expect(canUseListDelta({ lastSync: 5_000, clientEpoch: 'old', serverEpoch: 'new', now: 10_000 })).toBe(false)
        expect(canUseListDelta({ lastSync: 0, clientEpoch: 'a', serverEpoch: 'a', now: 10_000 })).toBe(false)
        expect(canUseListDelta({ lastSync: 10_001, clientEpoch: 'a', serverEpoch: 'a', now: 10_000 })).toBe(false)
        expect(canUseListDelta({
            lastSync: 10_000 - LIST_DELTA_MAX_AGE_MS - 1,
            clientEpoch: 'a',
            serverEpoch: 'a',
            now: 10_000,
        })).toBe(false)
    })

    it('returns full mode on epoch mismatch with the exact global asset-plus-kv union', async () => {
        const response = await buildListResponse(options({
            clientEpoch: 'old',
            serverEpoch: 'new',
            listKv: () => ['kv/live', 'assets/db-fallback'],
            listAssetEntries: () => [
                { key: 'assets/file', source: 'fs', mtimeMs: 9_000 },
                { key: 'assets/db-fallback', source: 'kv', mtimeMs: null },
            ],
        }))

        expect(response).toEqual({
            mode: 'full',
            content: ['assets/file', 'assets/db-fallback', 'kv/live'],
            timestamp: 10_000,
            epoch: 'new',
        })
    })

    it('returns recent filesystem and kv additions plus deletions for any asset-matching prefix', async () => {
        const listModifiedKv = vi.fn(() => ['assets/kv-added', 'assets/recent'])
        const listDeletedKv = vi.fn(() => ['assets/deleted'])
        const response = await buildListResponse(options({
            keyPrefix: 'assets/',
            listModifiedKv,
            listDeletedKv,
            listAssetEntries: () => [
                { key: 'assets/recent', source: 'fs', mtimeMs: 5_000 },
                { key: 'assets/old', source: 'fs', mtimeMs: 4_999 },
                { key: 'other/recent', source: 'fs', mtimeMs: 9_000 },
                { key: 'assets/kv-added', source: 'kv', mtimeMs: null },
            ],
        }))

        expect(response).toEqual({
            mode: 'delta',
            added: ['assets/recent', 'assets/kv-added'],
            deleted: ['assets/deleted'],
            timestamp: 10_000,
            epoch: 'epoch-a',
        })
        expect(listModifiedKv).toHaveBeenCalledWith(5_000, 'assets/')
        expect(listDeletedKv).toHaveBeenCalledWith(5_000, 'assets/')
    })

    it('uses inlay file mtimes and ignores transient stat failures', async () => {
        const response = await buildListResponse(options({
            keyPrefix: 'inlay/',
            listModifiedKv: () => ['inlay/kv-added'],
            listDeletedKv: () => ['inlay/deleted'],
            listInlayEntries: async () => [
                { id: 'recent', filePath: '/recent' },
                { id: 'old', filePath: '/old' },
                { id: 'gone', filePath: '/gone' },
            ],
            statFile: async (filePath) => {
                if (filePath === '/gone') throw new Error('ENOENT')
                return { mtimeMs: filePath === '/recent' ? 5_000 : 4_999 }
            },
        }))

        expect(response.added).toEqual(['inlay/recent', 'inlay/kv-added'])
        expect(response.deleted).toEqual(['inlay/deleted'])
    })

    it('falls back to an authoritative full inlay list before the stat pass exceeds its bound', async () => {
        const statFile = vi.fn(async () => ({ mtimeMs: 9_000 }))
        const response = await buildListResponse(options({
            keyPrefix: 'inlay/',
            maxInlayDeltaStatEntries: 2,
            listKv: () => ['inlay/legacy-kv', 'inlay/two'],
            listInlayEntries: async () => [
                { id: 'one', filePath: '/one' },
                { id: 'two', filePath: '/two' },
                { id: 'three', filePath: '/three' },
            ],
            statFile,
        }))

        expect(MAX_INLAY_DELTA_STAT_ENTRIES).toBeGreaterThan(0)
        expect(statFile).not.toHaveBeenCalled()
        expect(response).toEqual({
            mode: 'full',
            content: ['inlay/one', 'inlay/two', 'inlay/three', 'inlay/legacy-kv'],
            timestamp: 10_000,
            epoch: 'epoch-a',
        })
    })
})
