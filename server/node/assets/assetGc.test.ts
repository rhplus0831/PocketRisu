import { describe, expect, it } from 'vitest'
import pkg from './assetGc.cjs'

const {
    AssetReferenceScanLimitError,
    collectReferencedAssetKeys,
    planAssetGc,
} = pkg as {
    AssetReferenceScanLimitError: new (message: string) => Error
    collectReferencedAssetKeys: (
        root: unknown,
        known: Set<string>,
        target?: Set<string>,
        options?: { maxNodes?: number; maxDepth?: number },
    ) => Set<string>
    planAssetGc: (input: {
        assets: Array<{ key: string; source: string; size: number; mtimeMs: number | null }>
        referencedKeys: Set<string>
        candidates: Map<string, { firstUnreferencedAt: number; identity: string }>
        now: number
        graceMs: number
    }) => {
        clear: string[]
        mark: Array<{ key: string; identity: string; firstUnreferencedAt: number }>
        remove: string[]
        retainedByGrace: number
    }
}

describe('server asset reachability', () => {
    it('finds nested values, object keys, and asset paths embedded in strings', () => {
        const known = new Set([
            'assets/direct.png',
            'assets/key.webp',
            'assets/embedded.bin',
            'assets/legacy name with spaces.png',
        ])
        const value = {
            nested: ['assets/direct.png', { 'assets/key.webp': true }],
            markup: 'preview: [file](assets/embedded.bin).',
            legacy: 'preview: assets/legacy name with spaces.png (old)',
            ignored: 'assets/missing.png',
        }

        expect([...collectReferencedAssetKeys(value, known)].sort()).toEqual([...known].sort())
    })

    it('fails closed when traversal bounds are exceeded', () => {
        expect(() => collectReferencedAssetKeys(
            { one: { two: 'assets/kept.png' } },
            new Set(['assets/kept.png']),
            new Set(),
            { maxNodes: 1 },
        )).toThrow(AssetReferenceScanLimitError)
    })
})

describe('server asset GC planning', () => {
    const asset = {
        key: 'assets/orphan.png',
        source: 'fs',
        size: 12,
        mtimeMs: 1_000,
    }

    it('marks on the first observation and removes only after an independent grace pass', () => {
        const first = planAssetGc({
            assets: [asset],
            referencedKeys: new Set(),
            candidates: new Map(),
            now: 10_000,
            graceMs: 0,
        })
        expect(first.remove).toEqual([])
        expect(first.mark).toEqual([expect.objectContaining({ key: asset.key })])

        const second = planAssetGc({
            assets: [asset],
            referencedKeys: new Set(),
            candidates: new Map([[asset.key, {
                firstUnreferencedAt: first.mark[0].firstUnreferencedAt,
                identity: first.mark[0].identity,
            }]]),
            now: 10_000,
            graceMs: 0,
        })
        expect(second.remove).toEqual([asset.key])
    })

    it('clears reachable and missing candidates and restarts grace after replacement', () => {
        const candidates = new Map([
            [asset.key, { firstUnreferencedAt: 0, identity: '["fs",12,999]' }],
            ['assets/referenced.png', { firstUnreferencedAt: 0, identity: 'old' }],
            ['assets/missing.png', { firstUnreferencedAt: 0, identity: 'old' }],
        ])
        const plan = planAssetGc({
            assets: [asset, {
                key: 'assets/referenced.png',
                source: 'fs',
                size: 5,
                mtimeMs: 2_000,
            }],
            referencedKeys: new Set(['assets/referenced.png']),
            candidates,
            now: 20_000,
            graceMs: 1,
        })

        expect(plan.clear.sort()).toEqual(['assets/missing.png', 'assets/referenced.png'])
        expect(plan.mark).toEqual([expect.objectContaining({ key: asset.key })])
        expect(plan.remove).toEqual([])
    })
})
