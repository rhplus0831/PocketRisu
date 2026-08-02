import { describe, it, expect, afterAll } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import pkg from './chunkStore.cjs'

const {
    cdcSplit,
    createChunkStore,
    createSnapshotReader,
    isChunkableKey,
    normalizeThreshold,
    CHUNK_MARKER,
} = pkg as {
    cdcSplit: (buf: Buffer) => { hash: string; data: Buffer }[]
    isChunkableKey: (key: string) => boolean
    createChunkStore: (
        db: any,
        opts?: { threshold?: number },
    ) => {
        putValue: (key: string, value: Buffer) => void
        putValueFromFile: (key: string, filePath: string) => void
        writeValueToFile: (
            key: string,
            filePath: string,
            options?: {
                shouldAbort?: () => boolean
                signal?: AbortSignal
                onChunk?: (chunk: { index: number; size: number }) => void
            },
        ) => Promise<{ filePath: string; size: number; chunks: number; maxChunkBytes: number } | null>
        getValue: (key: string) => Buffer | null
        sizeValue: (key: string) => number | null
        listValuesWithSizes: (prefix: string) => Array<{ key: string; size: number }>
        listValuesWithSizesForKeys: (keys: string[]) => Array<{ key: string; size: number }>
        listSnapshotCostsExclusive: (prefix: string) => Array<{
            key: string
            size: number
            logicalSize: number
        }>
        snapshotCostExclusive: (key: string) => number
        snapshotValue: (srcKey: string, dstKey: string) => void
        dropValue: (key: string) => void
        gc: () => number
        isChunkedKey: (key: string) => boolean
        reclaimableBytes: () => number
        sizeInventoryMetrics: () => {
            fastSizeHits: number
            authoritativeSizeDerivations: number
            fastListingQueries: number
            aggregateListingQueries: number
            snapshotAggregateQueries: number
        }
    }
    createSnapshotReader: (db: any) => {
        kvGet: (key: string) => Buffer | null
        kvListWithSizes: (prefix: string) => Array<{ key: string; size: number }>
        kvSize: (key: string) => number | null
        kvReadRange: (key: string, offset: number, length: number) => Buffer | null
        kvWriteToFile: (
            key: string,
            filePath: string,
            options?: {
                shouldAbort?: () => boolean
                signal?: AbortSignal
                onChunk?: (chunk: { index: number; size: number }) => void | Promise<void>
            },
        ) => Promise<{ filePath: string; size: number; chunks: number; maxChunkBytes: number } | null>
    }
    normalizeThreshold: (value: unknown) => number
    CHUNK_MARKER: Buffer
}

// Fresh in-memory DB with the same kv schema db.cjs creates (kv is db.cjs's
// domain; chunkStore creates only its own chunks/manifest tables).
function freshDb() {
    const db = new Database(':memory:')
    db.exec(
        'CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    )
    return db
}
// Deterministic pseudo-random bytes (LCG) — reproducible so locality/dedup
// assertions never flake on RNG luck.
function seededBytes(n: number, seed = 1): Buffer {
    const out = Buffer.alloc(n)
    let h = seed >>> 0
    for (let i = 0; i < n; i++) {
        h = (Math.imul(h, 1664525) + 1013904223) >>> 0
        out[i] = h >>> 24
    }
    return out
}
const countChunks = (db: any) => db.prepare('SELECT COUNT(*) c FROM chunks').get().c as number
const countChunkBytes = (db: any) =>
    db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) b FROM chunks').get().b as number
const countManifest = (db: any, key: string) =>
    db.prepare('SELECT COUNT(*) c FROM manifest_chunks WHERE manifest_key = ?').get(key).c as number

describe('cdcSplit — content-defined chunking (pure)', () => {
    it('A1: 분할한 조각을 다시 이으면 원본과 바이트 동일', () => {
        const buf = randomBytes(200_000)
        const chunks = cdcSplit(buf)
        const reassembled = Buffer.concat(chunks.map((c) => c.data))
        expect(reassembled.equals(buf)).toBe(true)
    })

    it('A1b: 빈 버퍼는 조각 0개, 재조립은 빈 버퍼', () => {
        const chunks = cdcSplit(Buffer.alloc(0))
        expect(chunks).toHaveLength(0)
        expect(Buffer.concat(chunks.map((c) => c.data)).length).toBe(0)
    })

    it('A2: 같은 입력 → 같은 조각(경계·해시 결정적)', () => {
        const buf = randomBytes(200_000)
        const a = cdcSplit(buf).map((c) => c.hash)
        const b = cdcSplit(buf).map((c) => c.hash)
        expect(b).toEqual(a)
    })

    it('A3: 조각 크기가 min/max 경계 준수 (마지막 제외 ≥MIN, 전부 ≤MAX)', () => {
        const chunks = cdcSplit(randomBytes(500_000))
        chunks.forEach((c, i) => {
            expect(c.data.length).toBeLessThanOrEqual(65536)
            if (i < chunks.length - 1) expect(c.data.length).toBeGreaterThanOrEqual(4096)
        })
    })

    it('A4: 중간 삽입 시 변경 조각은 극소수 (CDC 재동기화 → dedup)', () => {
        const buf = seededBytes(2_000_000, 7)
        const at = 1_000_000
        const mutated = Buffer.concat([buf.subarray(0, at), seededBytes(120, 99), buf.subarray(at)])
        const base = cdcSplit(buf)
        const next = cdcSplit(mutated)
        const baseHashes = new Set(base.map((c) => c.hash))
        const changed = next.filter((c) => !baseHashes.has(c.hash))
        // 삽입 지점 한 조각 + 경계 정렬로 최대 몇 개. 버퍼 크기와 무관하게 소수.
        expect(changed.length).toBeLessThanOrEqual(3)
        const rewriteBytes = changed.reduce((s, c) => s + c.data.length, 0)
        expect(rewriteBytes).toBeLessThanOrEqual(3 * 65536) // 최대 3개 max-chunk 분량
    })
})

describe('createChunkStore — chunk-aware kv (injected :memory: db)', () => {
    const T = { threshold: 1024 } // small threshold so test buffers exercise chunking

    it('B0: chunk gate accepts every logical string key', () => {
        expect(isChunkableKey('database/database.bin')).toBe(true)
        expect(isChunkableKey('database/dbbackup-123.bin')).toBe(true)
        expect(isChunkableKey('chats/character/chat')).toBe(true)
        expect(isChunkableKey('pluginsave/dmVjdG9y.json')).toBe(true)
        expect(isChunkableKey('assets/large.bin')).toBe(true)
        expect(isChunkableKey('coldstorage/character')).toBe(true)
        expect(isChunkableKey('remotes/large.local.bin')).toBe(true)
        expect(isChunkableKey('pluginsave-meta/dmVjdG9y.json')).toBe(true)
        expect(isChunkableKey('database/other.bin')).toBe(true)
        expect(isChunkableKey('generic/extension-defined.bin')).toBe(true)
        expect(isChunkableKey('chats')).toBe(true)
        expect(isChunkableKey(null as unknown as string)).toBe(false)
    })

    it('B1: putValue(big) → getValue 바이트 동일 (라운드트립)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const buf = randomBytes(200_000)
        store.putValue('database/database.bin', buf)
        const got = store.getValue('database/database.bin')
        expect(got).not.toBeNull()
        expect((got as Buffer).equals(buf)).toBe(true)
        expect(countManifest(db, 'database/database.bin')).toBeGreaterThan(1) // 실제로 청킹됨
    })

    it('B2: 작은 값(<임계)은 평범한 행 — 청크 0', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const small = randomBytes(500)
        store.putValue('k', small)
        expect(countChunks(db)).toBe(0)
        expect(countManifest(db, 'k')).toBe(0)
        expect((store.getValue('k') as Buffer).equals(small)).toBe(true)
    })

    it('B3: 레거시 raw BLOB(마커 없음)은 그대로 반환', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const legacy = randomBytes(50_000) // 마커 없이 직접 박힌 옛 값
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('database/database.bin', legacy)
        expect((store.getValue('database/database.bin') as Buffer).equals(legacy)).toBe(true)
    })

    it('B3b: 레거시 값을 putValue로 덮으면 청킹으로 마이그레이션', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('k', randomBytes(50_000))
        const next = randomBytes(200_000)
        store.putValue('k', next)
        expect(countManifest(db, 'k')).toBeGreaterThan(1)
        expect((store.getValue('k') as Buffer).equals(next)).toBe(true)
    })

    it('B4: dedup — 유사 버퍼 2개는 chunks가 델타만큼만 증가', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const buf1 = randomBytes(200_000)
        store.putValue('k', buf1)
        const n1 = countChunks(db)
        const at = 100_000
        const buf2 = Buffer.concat([buf1.subarray(0, at), randomBytes(120), buf1.subarray(at)])
        store.putValue('k', buf2)
        expect(countChunks(db)).toBeLessThanOrEqual(n1 + 3) // 공유 조각은 INSERT OR IGNORE로 재기록 안 됨
    })

    it('B5: 축소/덮어쓰기 — big→small이면 manifest 비워지고 정확 반환', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', randomBytes(200_000))
        expect(countManifest(db, 'k')).toBeGreaterThan(1)
        const small = randomBytes(300)
        store.putValue('k', small)
        expect(countManifest(db, 'k')).toBe(0)
        expect((store.getValue('k') as Buffer).equals(small)).toBe(true)
    })

    it('B6: sizeValue는 논리 크기 반환 (청킹 여부 무관)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = randomBytes(200_000)
        store.putValue('big', big)
        store.putValue('small', randomBytes(300))
        expect(store.sizeValue('big')).toBe(big.length)
        expect(store.sizeValue('small')).toBe(300)
        expect(store.sizeValue('missing')).toBeNull()
    })

    it('B6b: revision-bound metadata is used only after authoritative verification', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = seededBytes(200_000, 211)
        store.putValue('big', big)

        expect(store.sizeInventoryMetrics()).toMatchObject({
            fastSizeHits: 0,
            authoritativeSizeDerivations: 0,
        })
        expect(store.sizeValue('big')).toBe(big.length)
        expect(store.sizeInventoryMetrics()).toMatchObject({
            fastSizeHits: 0,
            authoritativeSizeDerivations: 1,
        })
        const revision = db.prepare(`
            SELECT source_revision AS sourceRevision,
                   verified_revision AS verifiedRevision
              FROM chunk_manifest_inventory_revision
             WHERE manifest_key = 'big'
        `).get() as { sourceRevision: number; verifiedRevision: number }
        expect(revision).toMatchObject({
            sourceRevision: expect.any(Number),
            verifiedRevision: expect.any(Number),
        })
        expect(revision.sourceRevision).toBeLessThanOrEqual(3)
        expect(revision.verifiedRevision).toBe(revision.sourceRevision)

        expect(store.sizeValue('big')).toBe(big.length)
        expect(store.sizeInventoryMetrics()).toMatchObject({
            fastSizeHits: 1,
            authoritativeSizeDerivations: 1,
        })

        const hash = db.prepare(
            `SELECT hash FROM manifest_chunks WHERE manifest_key = 'big' ORDER BY seq LIMIT 1`,
        ).get().hash as string
        db.prepare('DELETE FROM chunks WHERE hash = ?').run(hash)
        expect(() => store.sizeValue('big')).toThrow(expect.objectContaining({
            code: 'KV_CHUNK_CORRUPT',
        }))
        expect(store.sizeInventoryMetrics().authoritativeSizeDerivations).toBe(2)
    })

    it('B7: 없는 키는 null', () => {
        const store = createChunkStore(freshDb(), T)
        expect(store.getValue('nope')).toBeNull()
    })

    it('B8: 마커와 정확히 같은 raw 값은 빈 버퍼가 아니라 원본 반환 (오탐 방어)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const marker = (pkg as { CHUNK_MARKER: Buffer }).CHUNK_MARKER
        // 청킹 안 거치고 마커와 동일한 바이트를 직접 박음 (천문학적 우연 시뮬)
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('k', marker)
        expect((store.getValue('k') as Buffer).equals(marker)).toBe(true)
        expect(store.snapshotCostExclusive('k')).toBe(marker.length)
    })

    it('B9: isChunkedKey — 청킹 키 true, raw/없음 false, 마커가 raw로 덮이면 false', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('big', randomBytes(200_000))
        store.putValue('small', randomBytes(300))
        expect(store.isChunkedKey('big')).toBe(true)
        expect(store.isChunkedKey('small')).toBe(false)
        expect(store.isChunkedKey('missing')).toBe(false)
        // raw 값이 마커를 덮은 stale 상태 → 청킹 아님으로 정확히 판정
        db.prepare("UPDATE kv SET value = ? WHERE key = 'big'").run(Buffer.from('raw'))
        expect(store.isChunkedKey('big')).toBe(false)
    })

    it('B10: live size enumeration reports logical plugin bytes without reassembly', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const large = randomBytes(200_000)
        store.putValue('pluginsave/bGFyZ2U.json', large)
        store.putValue('pluginsave/c21hbGw.json', Buffer.from('small'))

        expect(store.listValuesWithSizes('pluginsave/').sort((a, b) => a.key.localeCompare(b.key)))
            .toEqual([
                { key: 'pluginsave/bGFyZ2U.json', size: large.length },
                { key: 'pluginsave/c21hbGw.json', size: 5 },
            ])
    })

    it('B10b: stale listings use one grouped fallback and then the verified fast path', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const first = seededBytes(200_000, 221)
        const second = seededBytes(180_000, 223)
        store.putValue('pluginsave/a.json', first)
        store.putValue('pluginsave/b.json', second)
        store.putValue('pluginsave/raw.json', Buffer.from('raw'))

        expect(store.listValuesWithSizes('pluginsave/').sort((a, b) => a.key.localeCompare(b.key)))
            .toEqual([
                { key: 'pluginsave/a.json', size: first.length },
                { key: 'pluginsave/b.json', size: second.length },
                { key: 'pluginsave/raw.json', size: 3 },
            ])
        expect(store.sizeInventoryMetrics()).toMatchObject({
            authoritativeSizeDerivations: 0,
            fastListingQueries: 1,
            aggregateListingQueries: 1,
        })

        store.listValuesWithSizes('pluginsave/')
        expect(store.sizeInventoryMetrics()).toMatchObject({
            fastListingQueries: 2,
            aggregateListingQueries: 1,
        })
    })

    it('B10c: selected inventories aggregate only the requested authoritative rows', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const selected = seededBytes(200_000, 231)
        store.putValue('pluginsave/selected.json', selected)
        store.putValue('pluginsave/quarantined.json', seededBytes(180_000, 233))
        const quarantinedHash = db.prepare(`
            SELECT hash FROM manifest_chunks
             WHERE manifest_key = 'pluginsave/quarantined.json'
             ORDER BY seq LIMIT 1
        `).get().hash as string
        db.prepare('DELETE FROM chunks WHERE hash = ?').run(quarantinedHash)

        expect(store.listValuesWithSizesForKeys([
            'pluginsave/missing.json',
            'pluginsave/selected.json',
        ])).toEqual([
            { key: 'pluginsave/selected.json', size: selected.length },
        ])
        expect(store.sizeInventoryMetrics()).toMatchObject({
            authoritativeSizeDerivations: 0,
            fastListingQueries: 1,
            aggregateListingQueries: 1,
        })
    })
})

describe('snapshotValue — 조각 공유 스냅샷 (kvCopyValue 청크 인식)', () => {
    const T = { threshold: 1024 }

    it('C1: 청킹 값 스냅샷 → 바이트 동일 + 조각 중복 없음(공유)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = randomBytes(200_000)
        store.putValue('live', big)
        const before = countChunks(db)
        store.snapshotValue('live', 'snap')
        expect(countChunks(db)).toBe(before) // 조각 복사 안 함 — 공유
        expect((store.getValue('snap') as Buffer).equals(big)).toBe(true)
        expect((store.getValue('live') as Buffer).equals(big)).toBe(true)
    })

    it('C2: 스냅샷 후 live 변경 → 스냅샷은 옛 바이트 유지', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bufA = randomBytes(200_000)
        const bufB = randomBytes(200_000)
        store.putValue('live', bufA)
        store.snapshotValue('live', 'snap')
        store.putValue('live', bufB) // live 갱신 (옛 조각은 GC 전까지 잔존)
        expect((store.getValue('snap') as Buffer).equals(bufA)).toBe(true) // 스냅샷 불변
        expect((store.getValue('live') as Buffer).equals(bufB)).toBe(true)
    })

    it('C3: 작은(raw) 값 스냅샷도 정확 복사', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const small = randomBytes(300)
        store.putValue('live', small)
        store.snapshotValue('live', 'snap')
        expect((store.getValue('snap') as Buffer).equals(small)).toBe(true)
    })

    it('C4: 없는 src 스냅샷은 dst 무변경 (no-op)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('snap', randomBytes(300))
        store.snapshotValue('missing', 'snap') // src 없음
        expect((store.getValue('snap') as Buffer).length).toBe(300) // dst 그대로
    })

    it('C5: snapshotCostExclusive — 다른 manifest와 공유하면 0, 단독이면 full, raw는 full', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const v0 = randomBytes(200_000)
        store.putValue('live', v0)
        store.snapshotValue('live', 'snap')
        expect(store.snapshotCostExclusive('snap')).toBe(0) // live와 전부 공유
        store.putValue('live', randomBytes(200_000)) // live 완전 교체 → snap 조각이 단독
        expect(store.snapshotCostExclusive('snap')).toBeGreaterThan(150_000)
        store.putValue('rawsnap', randomBytes(500)) // < 임계 → raw
        expect(store.snapshotCostExclusive('rawsnap')).toBe(500)
        expect(store.snapshotCostExclusive('missing')).toBe(0)
    })

    it('C6: 두 snapshot의 공유 chunk는 둘 다 비용에서 제외되고 하나 삭제 시 다른 쪽 비용이 증가', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const v0 = seededBytes(2_000_000, 41)
        const at = 1_000_000
        const v1 = Buffer.concat([v0.subarray(0, at), seededBytes(120, 99), v0.subarray(at)])

        store.putValue('live', v0)
        store.snapshotValue('live', 'snapA')
        store.putValue('live', v1)
        store.snapshotValue('live', 'snapB')
        store.dropValue('live')

        const physicalBytes = (key: string) => db.prepare(
            `SELECT COALESCE(SUM(LENGTH(data)), 0) b FROM chunks
             WHERE hash IN (SELECT hash FROM manifest_chunks WHERE manifest_key = ?)`,
        ).get(key).b as number
        const sharedBytes = db.prepare(
            `SELECT COALESCE(SUM(LENGTH(data)), 0) b FROM chunks
             WHERE hash IN (SELECT hash FROM manifest_chunks WHERE manifest_key = 'snapA')
               AND hash IN (SELECT hash FROM manifest_chunks WHERE manifest_key = 'snapB')`,
        ).get().b as number

        const costA = store.snapshotCostExclusive('snapA')
        const costB = store.snapshotCostExclusive('snapB')
        expect(sharedBytes).toBeGreaterThan(0)
        expect(costA).toBe(physicalBytes('snapA') - sharedBytes)
        expect(costB).toBe(physicalBytes('snapB') - sharedBytes)
        expect(costA).toBeGreaterThan(0)
        expect(costB).toBeGreaterThan(0)

        store.dropValue('snapA')
        expect(store.snapshotCostExclusive('snapB')).toBe(costB + sharedBytes)
    })

    it('C7: snapshot footprint inventory batches all keys with identical exact costs', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const original = seededBytes(2_000_000, 227)
        const changed = Buffer.concat([
            original.subarray(0, 1_000_000),
            seededBytes(120, 229),
            original.subarray(1_000_000),
        ])
        store.putValue('live', original)
        store.snapshotValue('live', 'snapshot/a')
        store.putValue('live', changed)
        store.snapshotValue('live', 'snapshot/b')
        store.putValue('snapshot/raw', Buffer.alloc(500, 0x72))
        store.dropValue('live')

        const expected = new Map([
            ['snapshot/a', store.snapshotCostExclusive('snapshot/a')],
            ['snapshot/b', store.snapshotCostExclusive('snapshot/b')],
            ['snapshot/raw', store.snapshotCostExclusive('snapshot/raw')],
        ])
        const aggregate = store.listSnapshotCostsExclusive('snapshot/')
        expect(new Map(aggregate.map((entry) => [entry.key, entry.size]))).toEqual(expected)
        expect(new Map(aggregate.map((entry) => [entry.key, entry.logicalSize]))).toEqual(new Map([
            ['snapshot/a', original.length],
            ['snapshot/b', changed.length],
            ['snapshot/raw', 500],
        ]))
        expect(store.sizeInventoryMetrics().snapshotAggregateQueries).toBe(1)
    })
})

describe('gc — mark-sweep (참조 없는 조각만 삭제)', () => {
    const T = { threshold: 1024 }

    it('D1: 고아 조각(manifest 없음)은 삭제됨', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', randomBytes(200_000))
        const n = countChunks(db)
        expect(n).toBeGreaterThan(1)
        store.dropValue('k') // manifest 제거 → 조각 전부 고아
        expect(countChunks(db)).toBe(n) // 아직 잔존 (GC 전)
        expect(store.gc()).toBe(n) // GC가 n개 삭제
        expect(countChunks(db)).toBe(0)
    })

    it('D2: live가 참조하는 조각은 삭제 안 됨', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = randomBytes(200_000)
        store.putValue('live', big)
        const n = countChunks(db)
        expect(store.gc()).toBe(0)
        expect(countChunks(db)).toBe(n)
        expect((store.getValue('live') as Buffer).equals(big)).toBe(true)
    })

    it('D3: 스냅샷에만 있는 조각은 GC에서 생존 (유일 위험 봉쇄)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bufA = randomBytes(200_000)
        const bufB = randomBytes(200_000)
        store.putValue('live', bufA)
        store.snapshotValue('live', 'snap') // snap → bufA
        store.putValue('live', bufB) // live → bufB, bufA는 이제 snap만 참조
        store.gc() // bufA 조각을 지우면 안 됨
        expect((store.getValue('snap') as Buffer).equals(bufA)).toBe(true) // 스냅샷 생존 ✓
        expect((store.getValue('live') as Buffer).equals(bufB)).toBe(true)
    })

    it('D4: 스냅샷 로테이션(manifest 삭제) 후 그 조각만 회수, live 무사', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bufA = randomBytes(200_000)
        const bufB = randomBytes(200_000)
        store.putValue('live', bufA)
        store.snapshotValue('live', 'snap')
        store.putValue('live', bufB)
        const nb = countManifest(db, 'live') // bufB 조각 수
        store.dropValue('snap') // 로테이션 → bufA 조각 고아
        store.gc()
        expect(countChunks(db)).toBe(nb) // bufB 조각만 남음
        expect((store.getValue('live') as Buffer).equals(bufB)).toBe(true)
    })

    it('D5: GC 멱등 — 두 번째 실행은 0 삭제, 무변경', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', randomBytes(200_000))
        store.dropValue('k')
        store.gc()
        const after = countChunks(db)
        expect(store.gc()).toBe(0)
        expect(countChunks(db)).toBe(after)
    })

    it('D6: 스냅샷 로테이션 — dropValue로 삭제한 스냅샷 전용 조각만 회수, 산 스냅샷·live 보존', () => {
        // db.cjs의 kvDel→dropValue 경로가 의존하는 시나리오 (회귀 가드).
        const db = freshDb()
        const store = createChunkStore(db, T)
        const v0 = randomBytes(200_000)
        store.putValue('live', v0)
        store.snapshotValue('live', 'snapA') // snapA → v0
        const v1 = Buffer.concat([v0.subarray(0, 100_000), randomBytes(120), v0.subarray(100_000)])
        store.putValue('live', v1)
        store.snapshotValue('live', 'snapB') // snapB → v1
        store.dropValue('snapA') // 로테이션 = manifest까지 삭제
        store.gc()
        // snapB·live는 바이트 동일 유지
        expect((store.getValue('snapB') as Buffer).equals(v1)).toBe(true)
        expect((store.getValue('live') as Buffer).equals(v1)).toBe(true)
        // gc 후 고아 0 (v0 전용 조각이 회수됨)
        const distinct = db.prepare('SELECT COUNT(DISTINCT hash) c FROM manifest_chunks').get().c as number
        expect(countChunks(db)).toBe(distinct)
    })

    it('D6b: reclaimableBytes = 고아 바이트, 무관한 raw kv 값 다수에 영향 없음 (perf 회귀 가드)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('database/database.bin', randomBytes(200_000)) // v1
        const v1Bytes = countChunkBytes(db)
        store.putValue('database/database.bin', randomBytes(200_000)) // v2 → v1 조각 고아
        // assets 시뮬: 마커 아닌 raw kv 값 다수. correlated 쿼리는 이걸 안 스캔해야 정확+빠름.
        for (let i = 0; i < 100; i++) {
            db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('assets/' + i, randomBytes(500))
        }
        expect(store.reclaimableBytes()).toBe(v1Bytes) // 고아 = v1 조각 바이트, raw 값 무관
        expect(store.gc()).toBeGreaterThan(0)
        expect(store.reclaimableBytes()).toBe(0) // 회수 후 0
    })

    it('D7: kv 키 없는 stale manifest 자가치유 — 정리 + 누수 조각 회수, live 무사', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('live', randomBytes(200_000))
        store.snapshotValue('live', 'snap')
        store.putValue('live', randomBytes(200_000)) // live 교체 → snap 조각이 snap 전용이 됨
        // 옛 버그 시뮬: manifest는 남기고 kv 행만 삭제 (raw kvDel이 하던 짓)
        db.prepare("DELETE FROM kv WHERE key = 'snap'").run()
        expect(countManifest(db, 'snap')).toBeGreaterThan(0) // stale manifest 잔존
        const before = countChunks(db)
        store.gc()
        expect(countManifest(db, 'snap')).toBe(0) // stale manifest 정리됨
        expect(countChunks(db)).toBeLessThan(before) // snap 전용 조각 회수됨
        expect((store.getValue('live') as Buffer).length).toBeGreaterThan(0) // live 무사
    })

    it('D8: raw 값이 마커를 덮은 stale manifest도 자가치유 (kv 키는 있지만 마커 아님)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('live', randomBytes(200_000))
        store.snapshotValue('live', 'snap')
        store.putValue('live', randomBytes(200_000)) // snap 조각이 단독이 됨
        // 옛/누락 경로 시뮬: snap의 kv 값을 raw로 덮되 manifest는 남김
        db.prepare("UPDATE kv SET value = ? WHERE key = 'snap'").run(Buffer.from('raw not marker'))
        expect(countManifest(db, 'snap')).toBeGreaterThan(0)
        const before = countChunks(db)
        store.gc() // 마커 아님 → stale로 판정해 정리
        expect(countManifest(db, 'snap')).toBe(0)
        expect(countChunks(db)).toBeLessThan(before)
        expect((store.getValue('live') as Buffer).length).toBeGreaterThan(0)
    })
})

describe('putValueFromFile — 파일 스트리밍 쓰기 (putValue와 저장 동일성)', () => {
    const T = { threshold: 1024 }
    const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-chunk-file-'))
    afterAll(() => fs.rmSync(fileDir, { recursive: true, force: true }))

    function writeTemp(name: string, bytes: Buffer): string {
        const filePath = path.join(fileDir, name)
        fs.writeFileSync(filePath, bytes)
        return filePath
    }
    const tableDump = (db: any, key: string) => ({
        kv: db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value,
        manifest: db.prepare(
            'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq',
        ).all(key),
        chunks: db.prepare('SELECT hash, LENGTH(data) len FROM chunks ORDER BY hash').all(),
    })

    it('E1: 큰 파일 → putValue와 동일한 조각·manifest·바이트 (윈도우 경계 무관)', () => {
        // MAX_SIZE(65536)의 배수와 비배수 크기 모두 — 마지막 윈도우가 잘리는
        // 경우와 정확히 맞는 경우의 경계 동등성을 함께 검증한다.
        for (const size of [65536 * 3, 300_000]) {
            const bytes = seededBytes(size, size)
            const viaBuffer = freshDb()
            createChunkStore(viaBuffer, T).putValue('k', bytes)
            const viaFile = freshDb()
            const store = createChunkStore(viaFile, T)
            store.putValueFromFile('k', writeTemp(`big-${size}`, bytes))

            expect(tableDump(viaFile, 'k')).toEqual(tableDump(viaBuffer, 'k'))
            expect((store.getValue('k') as Buffer).equals(bytes)).toBe(true)
        }
    })

    it('E2: 임계 이하 파일은 평범한 행 — 청크 0, 바이트 동일', () => {
        const bytes = seededBytes(1024, 7)
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValueFromFile('k', writeTemp('small', bytes))
        expect(countChunks(db)).toBe(0)
        expect((store.getValue('k') as Buffer).equals(bytes)).toBe(true)
    })

    it('E3: 기존 청킹 값 덮어쓰기 — manifest 교체 후 정확 반환', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', seededBytes(200_000, 1))
        const replacement = seededBytes(50_000, 2)
        store.putValueFromFile('k', writeTemp('replace', replacement))
        expect((store.getValue('k') as Buffer).equals(replacement)).toBe(true)
        expect(countManifest(db, 'k')).toBeGreaterThan(0)
    })
})

describe('writeValueToFile — bounded snapshot restore source', () => {
    const T = { threshold: 1024 }
    const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-chunk-read-file-'))
    afterAll(() => fs.rmSync(fileDir, { recursive: true, force: true }))

    it('F1: streams a high-chunk-count value with one bounded chunk at a time', async () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bytes = seededBytes(20 * 1024 * 1024, 87)
        store.putValue('database/dbbackup-1.bin', bytes)
        const filePath = path.join(fileDir, 'snapshot.risudat.tmp')
        let callbacks = 0
        let active = 0
        let maxActive = 0
        const result = (await store.writeValueToFile('database/dbbackup-1.bin', filePath, {
            onChunk: ({ size }) => {
                active++
                maxActive = Math.max(maxActive, active)
                expect(size).toBeLessThanOrEqual(65536)
                callbacks++
                active--
            },
        }))!

        expect(result.chunks).toBeGreaterThan(300)
        expect(result.chunks).toBe(callbacks)
        expect(result.maxChunkBytes).toBeLessThanOrEqual(65536)
        expect(maxActive).toBe(1)
        expect(result.size).toBe(bytes.length)
        expect(fs.readFileSync(filePath).equals(bytes)).toBe(true)
    })

    it('F2: cancellation removes the partial spool immediately', async () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('database/dbbackup-2.bin', seededBytes(2 * 1024 * 1024, 91))
        const filePath = path.join(fileDir, 'cancelled.risudat.tmp')
        let chunks = 0
        await expect(store.writeValueToFile('database/dbbackup-2.bin', filePath, {
            shouldAbort: () => chunks >= 4,
            onChunk: () => { chunks++ },
        })).rejects.toThrow('KV value stream cancelled')
        expect(chunks).toBe(4)
        expect(fs.existsSync(filePath)).toBe(false)
    })

    it('F3: missing values do not create a spool file', async () => {
        const store = createChunkStore(freshDb(), T)
        const filePath = path.join(fileDir, 'missing.risudat.tmp')
        expect(await store.writeValueToFile('missing', filePath)).toBeNull()
        expect(fs.existsSync(filePath)).toBe(false)
    })

    it('F4: pages legacy oversized raw rows through <=64 KiB substr reads', async () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bytes = seededBytes(20 * 1024 * 1024, 131)
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            'database/dbbackup-legacy.bin', bytes, Date.now(),
        )
        const filePath = path.join(fileDir, 'legacy-raw.risudat.tmp')
        const partSizes: number[] = []
        const result = (await store.writeValueToFile(
            'database/dbbackup-legacy.bin',
            filePath,
            { onChunk: ({ size }) => partSizes.push(size) },
        ))!

        expect(result.size).toBe(bytes.length)
        expect(result.chunks).toBe(320)
        expect(Math.max(...partSizes)).toBeLessThanOrEqual(65536)
        expect(fs.readFileSync(filePath).equals(bytes)).toBe(true)
    })

    it('F5: rejects missing, altered, reordered, and substituted chunk publications', async () => {
        const corruptions: Array<{
            name: string
            mutate: (db: Database.Database, key: string) => void
        }> = [
            {
                name: 'missing',
                mutate: (db, key) => {
                    const row = db.prepare(
                        'SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 1 OFFSET 2',
                    ).get(key) as { hash: string }
                    db.prepare('DELETE FROM chunks WHERE hash = ?').run(row.hash)
                },
            },
            {
                name: 'altered',
                mutate: (db, key) => {
                    const row = db.prepare(
                        'SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 1 OFFSET 2',
                    ).get(key) as { hash: string }
                    db.prepare('UPDATE chunks SET data = ? WHERE hash = ?').run(Buffer.from('altered'), row.hash)
                },
            },
            {
                name: 'reordered',
                mutate: (db, key) => {
                    db.prepare('UPDATE manifest_chunks SET seq = -1 WHERE manifest_key = ? AND seq = 1').run(key)
                    db.prepare('UPDATE manifest_chunks SET seq = 1 WHERE manifest_key = ? AND seq = 2').run(key)
                    db.prepare('UPDATE manifest_chunks SET seq = 2 WHERE manifest_key = ? AND seq = -1').run(key)
                },
            },
            {
                name: 'substituted',
                mutate: (db, key) => {
                    const rows = db.prepare(
                        'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 2',
                    ).all(key) as Array<{ seq: number; hash: string }>
                    db.prepare(
                        'UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?',
                    ).run(rows[0].hash, key, rows[1].seq)
                },
            },
            {
                name: 'metadata-deleted-missing-tail',
                mutate: (db, key) => {
                    db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(key)
                    db.prepare(
                        `DELETE FROM manifest_chunks WHERE manifest_key = ? AND seq = (
                            SELECT MAX(seq) FROM manifest_chunks WHERE manifest_key = ?
                        )`,
                    ).run(key, key)
                },
            },
            {
                name: 'metadata-deleted-reordered',
                mutate: (db, key) => {
                    db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(key)
                    db.prepare('UPDATE manifest_chunks SET seq = -1 WHERE manifest_key = ? AND seq = 1').run(key)
                    db.prepare('UPDATE manifest_chunks SET seq = 1 WHERE manifest_key = ? AND seq = 2').run(key)
                    db.prepare('UPDATE manifest_chunks SET seq = 2 WHERE manifest_key = ? AND seq = -1').run(key)
                },
            },
            {
                name: 'metadata-and-manifest-deleted',
                mutate: (db, key) => {
                    db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(key)
                    db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?').run(key)
                },
            },
        ]

        for (const corruption of corruptions) {
            const db = freshDb()
            const store = createChunkStore(db, T)
            const key = `database/dbbackup-corrupt-${corruption.name}.bin`
            store.putValue(key, seededBytes(400_000, 149))
            corruption.mutate(db, key)
            const filePath = path.join(fileDir, `${corruption.name}.risudat.tmp`)
            await expect(store.writeValueToFile(key, filePath)).rejects.toMatchObject({
                code: 'KV_CHUNK_CORRUPT',
            })
            expect(fs.existsSync(filePath)).toBe(false)
        }
    })

    it('F6: publishes count, length, and logical SHA metadata for new chunk manifests', async () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const key = 'database/dbbackup-meta.bin'
        const bytes = seededBytes(300_000, 157)
        store.putValue(key, bytes)
        const metadata = db.prepare(
            'SELECT chunk_count, logical_size, logical_sha256 FROM chunk_manifest_meta WHERE manifest_key = ?',
        ).get(key) as { chunk_count: number; logical_size: number; logical_sha256: string }
        expect(metadata.chunk_count).toBe(countManifest(db, key))
        expect(metadata.logical_size).toBe(bytes.length)
        expect(metadata.logical_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    })

    it('F7: migrates legacy manifests once and never reinterprets missing protected metadata', async () => {
        const db = freshDb()
        const key = 'database/dbbackup-legacy-metadata.bin'
        const bytes = seededBytes(300_000, 163)
        createChunkStore(db, T).putValue(key, bytes)

        // Recreate the pre-protection layout, then open the upgraded store. The
        // migration verifies the legacy chunks and publishes metadata + marker
        // in one transaction.
        db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(key)
        db.prepare('DELETE FROM chunk_manifest_publications WHERE manifest_key = ?').run(key)
        db.prepare('DELETE FROM chunk_manifest_protection').run()
        const migrated = createChunkStore(db, T)
        const protection = db.prepare(
            'SELECT version FROM chunk_manifest_protection WHERE id = 1',
        ).get() as { version: number }
        const metadata = db.prepare(
            'SELECT chunk_count, logical_size, logical_sha256 FROM chunk_manifest_meta WHERE manifest_key = ?',
        ).get(key) as { chunk_count: number; logical_size: number; logical_sha256: string }
        expect(protection.version).toBe(2)
        expect(metadata.chunk_count).toBe(countManifest(db, key))
        expect(metadata.logical_size).toBe(bytes.length)
        expect(metadata.logical_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))

        // A later metadata deletion remains corruption across another open;
        // the durable protection marker prevents a second legacy migration.
        db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(key)
        const reopened = createChunkStore(db, T)
        expect(db.prepare(
            'SELECT 1 FROM chunk_manifest_meta WHERE manifest_key = ?',
        ).get(key)).toBeUndefined()
        const filePath = path.join(fileDir, 'legacy-metadata-downgrade.risudat.tmp')
        await expect(reopened.writeValueToFile(key, filePath)).rejects.toMatchObject({
            code: 'KV_CHUNK_CORRUPT',
        })
        expect(fs.existsSync(filePath)).toBe(false)

        // The already-open upgraded store observes the same durable damage;
        // no hidden per-instance downgrade state can return the marker raw.
        expect(() => migrated.getValue(key)).toThrow(expect.objectContaining({
            code: 'KV_CHUNK_CORRUPT',
        }))
    })

    it('F8: protects a corrupt legacy key and continues migrating valid siblings', async () => {
        const db = freshDb()
        const corruptKey = 'database/dbbackup-corrupt-legacy.bin'
        const validKey = 'database/dbbackup-valid-legacy.bin'
        const validBytes = seededBytes(300_000, 169)
        const seeded = createChunkStore(db, T)
        seeded.putValue(corruptKey, seededBytes(300_000, 167))
        seeded.putValue(validKey, validBytes)
        const middle = db.prepare(
            'SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 1 OFFSET 2',
        ).get(corruptKey) as { hash: string }
        db.prepare('DELETE FROM chunk_manifest_meta').run()
        db.prepare('DELETE FROM chunk_manifest_publications').run()
        db.prepare('DELETE FROM chunk_manifest_protection').run()
        db.prepare('UPDATE chunks SET data = ? WHERE hash = ?').run(Buffer.from('corrupt'), middle.hash)

        const migrated = createChunkStore(db, T)
        expect(db.prepare('SELECT version FROM chunk_manifest_protection WHERE id = 1').get())
            .toEqual({ version: 2 })
        expect(db.prepare(
            'SELECT 1 FROM chunk_manifest_meta WHERE manifest_key = ?',
        ).get(corruptKey)).toBeUndefined()
        expect(db.prepare(
            'SELECT 1 FROM chunk_manifest_publications WHERE manifest_key = ?',
        ).get(corruptKey)).toBeDefined()
        expect(migrated.getValue(validKey)).toEqual(validBytes)

        for (const operation of [
            () => migrated.getValue(corruptKey),
            () => migrated.sizeValue(corruptKey),
            () => migrated.snapshotCostExclusive(corruptKey),
        ]) {
            expect(operation).toThrow(expect.objectContaining({ code: 'KV_CHUNK_CORRUPT' }))
        }
        const filePath = path.join(fileDir, 'corrupt-legacy-protected.risudat.tmp')
        await expect(migrated.writeValueToFile(corruptKey, filePath)).rejects.toMatchObject({
            code: 'KV_CHUNK_CORRUPT',
        })
        expect(fs.existsSync(filePath)).toBe(false)
    })

    it('F9: preserves a legitimate raw value equal to the chunk marker', async () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const source = 'database/dbbackup-raw-marker.bin'
        const copy = 'database/dbbackup-raw-marker-copy.bin'
        store.putValue(source, CHUNK_MARKER)

        expect(db.prepare(
            'SELECT 1 FROM chunk_manifest_publications WHERE manifest_key = ?',
        ).get(source)).toBeUndefined()
        expect(store.getValue(source)).toEqual(CHUNK_MARKER)
        expect(store.sizeValue(source)).toBe(CHUNK_MARKER.length)
        expect(store.isChunkedKey(source)).toBe(false)

        const sourcePath = path.join(fileDir, 'raw-marker.risudat.tmp')
        const sourceResult = await store.writeValueToFile(source, sourcePath)
        expect(sourceResult?.size).toBe(CHUNK_MARKER.length)
        expect(fs.readFileSync(sourcePath)).toEqual(CHUNK_MARKER)

        store.snapshotValue(source, copy)
        expect(store.getValue(copy)).toEqual(CHUNK_MARKER)
        expect(store.isChunkedKey(copy)).toBe(false)
        expect(db.prepare(
            'SELECT 1 FROM chunk_manifest_publications WHERE manifest_key = ?',
        ).get(copy)).toBeUndefined()
    })

    it('F10: rejects a fully deleted protected publication through every logical API', async () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const source = 'database/dbbackup-fully-deleted.bin'
        const destination = 'database/dbbackup-copy-target.bin'
        const destinationBytes = Buffer.from('destination-before')
        store.putValue(source, seededBytes(400_000, 173))
        store.putValue(destination, destinationBytes)
        db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(source)
        db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?').run(source)

        for (const operation of [
            () => store.getValue(source),
            () => store.sizeValue(source),
            () => store.listValuesWithSizes('database/'),
            () => store.snapshotCostExclusive(source),
            () => store.isChunkedKey(source),
            () => store.snapshotValue(source, destination),
        ]) {
            expect(operation).toThrow(expect.objectContaining({ code: 'KV_CHUNK_CORRUPT' }))
        }
        expect(store.getValue(destination)).toEqual(destinationBytes)

        const reader = createSnapshotReader(db)
        expect(() => reader.kvGet(source)).toThrow(expect.objectContaining({
            code: 'KV_CHUNK_CORRUPT',
        }))
        expect(() => reader.kvListWithSizes('database/')).toThrow(expect.objectContaining({
            code: 'KV_CHUNK_CORRUPT',
        }))

        const filePath = path.join(fileDir, 'fully-deleted.risudat.tmp')
        await expect(store.writeValueToFile(source, filePath)).rejects.toMatchObject({
            code: 'KV_CHUNK_CORRUPT',
        })
        expect(fs.existsSync(filePath)).toBe(false)
    })

    it('F11: readonly snapshots page chunked and legacy rows with ranges, integrity, and cancellation', async () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const chunkedKey = 'pluginsave/snapshot-cursor.json'
        const chunked = seededBytes(20 * 1024 * 1024, 181)
        const rawKey = 'coldstorage/snapshot-cursor'
        const raw = seededBytes(20 * 1024 * 1024, 191)
        store.putValue(chunkedKey, chunked)
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            rawKey,
            raw,
            Date.now(),
        )
        const reader = createSnapshotReader(db)

        for (const [key, value] of [[chunkedKey, chunked], [rawKey, raw]] as const) {
            const filePath = path.join(fileDir, `${path.basename(key)}.snapshot.tmp`)
            const pages: number[] = []
            const result = await reader.kvWriteToFile(key, filePath, {
                onChunk: async ({ size }) => {
                    pages.push(size)
                    await new Promise(resolve => setImmediate(resolve))
                },
            })
            expect(result).toMatchObject({ size: value.length })
            expect(result!.maxChunkBytes).toBeLessThanOrEqual(65536)
            expect(Math.max(...pages)).toBeLessThanOrEqual(65536)
            expect(fs.readFileSync(filePath).equals(value)).toBe(true)
            expect(reader.kvSize(key)).toBe(value.length)
            expect(reader.kvReadRange(key, 0, 2)).toEqual(value.subarray(0, 2))
            expect(reader.kvReadRange(key, value.length - 4, 4)).toEqual(value.subarray(-4))
            expect(reader.kvReadRange(key, 65_500, 100)).toEqual(value.subarray(65_500, 65_600))
        }

        const cancelledPath = path.join(fileDir, 'snapshot-cursor-cancelled.tmp')
        const controller = new AbortController()
        let chunks = 0
        await expect(reader.kvWriteToFile(chunkedKey, cancelledPath, {
            signal: controller.signal,
            onChunk: () => {
                chunks++
                if (chunks === 4) controller.abort(new Error('cancel snapshot cursor'))
            },
        })).rejects.toThrow('cancel snapshot cursor')
        expect(chunks).toBe(4)
        expect(fs.existsSync(cancelledPath)).toBe(false)

        const corruptPath = path.join(fileDir, 'snapshot-cursor-corrupt.tmp')
        const victim = db.prepare(
            'SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 1 OFFSET 2',
        ).get(chunkedKey) as { hash: string }
        db.prepare('UPDATE chunks SET data = ? WHERE hash = ?').run(Buffer.from('bad'), victim.hash)
        await expect(reader.kvWriteToFile(chunkedKey, corruptPath)).rejects.toMatchObject({
            code: 'KV_CHUNK_CORRUPT',
        })
        expect(fs.existsSync(corruptPath)).toBe(false)
    })

    it('F12: readonly snapshot cursors reject every raw/chunk corruption and remove partial files', async () => {
        const absentDb = freshDb()
        createChunkStore(absentDb, T)
        const absentReader = createSnapshotReader(absentDb)
        const absentPath = path.join(fileDir, 'snapshot-absent.tmp')
        await expect(absentReader.kvWriteToFile('missing', absentPath)).resolves.toBeNull()
        expect(fs.existsSync(absentPath)).toBe(false)

        const rawDb = freshDb()
        createChunkStore(rawDb, T)
        const rawKey = 'coldstorage/raw-truncated-during-cursor'
        const raw = seededBytes(4 * 65536 + 7, 211)
        rawDb.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
            .run(rawKey, raw, Date.now())
        const rawReader = createSnapshotReader(rawDb)
        const rawPath = path.join(fileDir, 'snapshot-raw-truncated.tmp')
        await expect(rawReader.kvWriteToFile(rawKey, rawPath, {
            onChunk: ({ index }) => {
                if (index === 0) {
                    rawDb.prepare('UPDATE kv SET value = ? WHERE key = ?')
                        .run(raw.subarray(0, 65536), rawKey)
                }
            },
        })).rejects.toMatchObject({ code: 'KV_CHUNK_CORRUPT' })
        expect(fs.existsSync(rawPath)).toBe(false)

        const corruptions: Array<{
            name: string
            mutate: (db: any, key: string) => void
            rangeFails?: boolean
        }> = [
            {
                name: 'missing-manifest-row',
                mutate(db, key) {
                    db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ? AND seq = 1')
                        .run(key)
                },
            },
            {
                name: 'missing-chunk-row',
                mutate(db, key) {
                    const { hash } = db.prepare(
                        'SELECT hash FROM manifest_chunks WHERE manifest_key = ? AND seq = 0',
                    ).get(key) as { hash: string }
                    db.prepare('DELETE FROM chunks WHERE hash = ?').run(hash)
                },
                rangeFails: true,
            },
            {
                name: 'duplicated-logical-chunk',
                mutate(db, key) {
                    const rows = db.prepare(
                        'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 2',
                    ).all(key) as Array<{ seq: number; hash: string }>
                    db.prepare('UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?')
                        .run(rows[0].hash, key, rows[1].seq)
                    const { size } = db.prepare(
                        `SELECT SUM(LENGTH(c.data)) AS size FROM manifest_chunks m
                         JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?`,
                    ).get(key) as { size: number }
                    db.prepare('UPDATE chunk_manifest_meta SET logical_size = ? WHERE manifest_key = ?')
                        .run(size, key)
                },
            },
            {
                name: 'reordered-chunks',
                mutate(db, key) {
                    const rows = db.prepare(
                        'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 2',
                    ).all(key) as Array<{ seq: number; hash: string }>
                    db.prepare('UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?')
                        .run(rows[1].hash, key, rows[0].seq)
                    db.prepare('UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?')
                        .run(rows[0].hash, key, rows[1].seq)
                },
            },
            {
                name: 'chunk-hash-mismatch',
                mutate(db, key) {
                    const { hash } = db.prepare(
                        'SELECT hash FROM manifest_chunks WHERE manifest_key = ? AND seq = 0',
                    ).get(key) as { hash: string }
                    const { data } = db.prepare('SELECT data FROM chunks WHERE hash = ?')
                        .get(hash) as { data: Buffer }
                    const changed = Buffer.from(data)
                    changed[0] ^= 0xff
                    db.prepare('UPDATE chunks SET data = ? WHERE hash = ?').run(changed, hash)
                },
                rangeFails: true,
            },
            {
                name: 'logical-size',
                mutate(db, key) {
                    db.prepare(
                        'UPDATE chunk_manifest_meta SET logical_size = logical_size + 1 WHERE manifest_key = ?',
                    ).run(key)
                },
            },
            {
                name: 'logical-sha',
                mutate(db, key) {
                    db.prepare(
                        'UPDATE chunk_manifest_meta SET logical_sha256 = ? WHERE manifest_key = ?',
                    ).run('0'.repeat(64), key)
                },
            },
            {
                name: 'missing-meta',
                mutate(db, key) {
                    db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(key)
                },
            },
            {
                name: 'missing-publication',
                mutate(db, key) {
                    db.prepare('DELETE FROM chunk_manifest_publications WHERE manifest_key = ?').run(key)
                },
            },
        ]

        for (const corruption of corruptions) {
            const db = freshDb()
            const store = createChunkStore(db, T)
            const key = `pluginsave/snapshot-${corruption.name}.json`
            const value = seededBytes(400_000, 223)
            store.putValue(key, value)
            corruption.mutate(db, key)
            const reader = createSnapshotReader(db)
            const output = path.join(fileDir, `snapshot-${corruption.name}.tmp`)
            await expect(reader.kvWriteToFile(key, output)).rejects.toMatchObject({
                code: 'KV_CHUNK_CORRUPT',
            })
            expect(fs.existsSync(output)).toBe(false)
            if (corruption.rangeFails) {
                expect(() => reader.kvReadRange(key, 0, 64))
                    .toThrow(expect.objectContaining({ code: 'KV_CHUNK_CORRUPT' }))
            }
            db.close()
        }
    })
})

describe('normalizeThreshold — lower-only bounded raw storage', () => {
    it('accepts lower finite positive values and clamps every unsafe value', () => {
        expect(normalizeThreshold(4096)).toBe(4096)
        expect(normalizeThreshold('1024')).toBe(1024)
        expect(normalizeThreshold(99_999_999_999)).toBe(16 * 1024 * 1024)
        for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'wat']) {
            expect(normalizeThreshold(value)).toBe(16 * 1024 * 1024)
        }
    })
})
