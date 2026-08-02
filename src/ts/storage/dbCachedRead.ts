import { decodeRawMsgpack } from './rawMsgpack'
import {
    RESOURCE_CACHE_MAX_ENTRIES,
    RESOURCE_CACHE_MAX_STORED_BYTES,
    RESOURCE_CACHE_MAX_VALUE_BYTES,
    isSha256Hex,
    sha256Bytes,
    sha256OwnedBytes,
} from './resourceCache'

export const DB_CACHE_VERSION = 1 as const
export const DB_CACHE_MAX_HASHES = 8192
export const DB_CACHE_GROUPS = ['root', 'characters', 'botPresets', 'modules', 'personas'] as const
export const DB_CACHE_ARRAY_GROUPS = ['characters', 'botPresets', 'modules', 'personas'] as const

export type DbCacheGroup = (typeof DB_CACHE_GROUPS)[number]
export type DbCacheInventory = Record<DbCacheGroup, string[]>

export interface DbCacheEntry {
    hash: string
    bytes: Uint8Array
}

export interface DbCacheManifestUpdate {
    key: string
    hashes: string[]
    entries: DbCacheEntry[]
    kind: 'database'
}

export interface AssembledCachedDbRead {
    database: Record<string, any>
    etag: string
    updates: DbCacheManifestUpdate[]
}

export interface DbCacheStagingLimits {
    maxBytes?: number
    maxEntries?: number
    maxValueBytes?: number
}

interface ResolvedSegment {
    value: any
    hash: string | null
    entry: DbCacheEntry | null
}

interface DbCacheStagingAdmission {
    admitOwnedBytes: (bytes: Uint8Array) => Promise<DbCacheEntry | null>
}

export async function decodeAndAssembleCachedDbRead(
    encodedEnvelope: Uint8Array,
    inventory: DbCacheInventory,
    loadCachedBytes: (hash: string) => Promise<Uint8Array | null>,
    stagingLimits: DbCacheStagingLimits = {},
): Promise<AssembledCachedDbRead> {
    const envelope = decodeRawMsgpack(encodedEnvelope)
    if (
        !isRecord(envelope)
        || envelope.version !== DB_CACHE_VERSION
        || !/^[0-9a-f]{32}$/.test(envelope.etag as string)
        || !hasExactKeys(envelope, ['version', 'etag', ...DB_CACHE_GROUPS])
    ) {
        throw new Error('Malformed cached database envelope')
    }

    const admission = createStagingAdmission(stagingLimits)
    const root = await resolveSegment(
        envelope.root,
        new Set(inventory.root),
        loadCachedBytes,
        admission,
    )
    if (!isRecord(root.value)) throw new Error('Cached database root must decode to an object')
    for (const group of DB_CACHE_ARRAY_GROUPS) {
        if (Object.prototype.hasOwnProperty.call(root.value, group)) {
            throw new Error(`Cached database root unexpectedly contains ${group}`)
        }
    }

    const database = root.value
    const updates: DbCacheManifestUpdate[] = [{
        key: 'db:root',
        hashes: root.hash ? [root.hash] : [],
        entries: root.entry ? [root.entry] : [],
        kind: 'database',
    }]

    for (const group of DB_CACHE_ARRAY_GROUPS) {
        const projected = envelope[group]
        if (!Array.isArray(projected)) throw new Error(`Cached database ${group} must be an array`)
        const resolved = await resolveSegmentArray(
            projected,
            new Set(inventory[group]),
            loadCachedBytes,
            admission,
        )
        database[group] = resolved.map(({ value }) => value)
        updates.push({
            key: `db:${group}`,
            hashes: resolved.flatMap(({ hash }) => hash ? [hash] : []),
            entries: resolved
                .filter((segment): segment is ResolvedSegment & { entry: DbCacheEntry } => segment.entry !== null)
                .map(({ entry }) => entry),
            kind: 'database',
        })
    }

    return {
        database,
        etag: envelope.etag as string,
        updates,
    }
}

async function resolveSegmentArray(
    projected: unknown[],
    inventory: ReadonlySet<string>,
    loadCachedBytes: (hash: string) => Promise<Uint8Array | null>,
    admission: DbCacheStagingAdmission,
): Promise<ResolvedSegment[]> {
    const resolved: ResolvedSegment[] = []
    for (let offset = 0; offset < projected.length; offset += 32) {
        const batch = projected.slice(offset, offset + 32)
        resolved.push(...await Promise.all(
            batch.map((segment) => resolveSegment(
                segment,
                inventory,
                loadCachedBytes,
                admission,
            )),
        ))
    }
    return resolved
}

async function resolveSegment(
    projected: unknown,
    inventory: ReadonlySet<string>,
    loadCachedBytes: (hash: string) => Promise<Uint8Array | null>,
    admission: DbCacheStagingAdmission,
): Promise<ResolvedSegment> {
    if (!isRecord(projected)) throw new Error('Malformed cached database segment')
    const keys = Object.keys(projected)
    if (keys.length !== 1) throw new Error('Malformed cached database segment')

    if (keys[0] === 'hash') {
        const hash = projected.hash
        if (!isSha256Hex(hash) || !inventory.has(hash)) {
            throw new Error('Server claimed an unadvertised database cache hit')
        }
        const bytes = await loadCachedBytes(hash)
        if (!bytes || await sha256Bytes(bytes) !== hash) {
            throw new Error('Claimed database cache hit is unavailable or corrupt')
        }
        return {
            value: decodeRawMsgpack(bytes),
            hash,
            entry: null,
        }
    }

    if (keys[0] === 'bytes') {
        const bytes = readBytes(projected.bytes)
        if (!bytes) throw new Error('Malformed cached database segment bytes')
        // Remove the envelope's reference immediately. An admitted entry keeps
        // this owned buffer until its background IndexedDB put; a skipped miss
        // becomes collectible as soon as this resolver returns.
        delete projected.bytes
        const value = decodeRawMsgpack(bytes)
        const entry = await admission.admitOwnedBytes(bytes)
        return {
            value,
            hash: entry?.hash ?? null,
            entry,
        }
    }

    throw new Error('Malformed cached database segment')
}

function createStagingAdmission(
    limits: DbCacheStagingLimits,
): DbCacheStagingAdmission {
    const maxBytes = normalizeLimit(limits.maxBytes, RESOURCE_CACHE_MAX_STORED_BYTES)
    const maxEntries = normalizeLimit(limits.maxEntries, RESOURCE_CACHE_MAX_ENTRIES)
    const maxValueBytes = normalizeLimit(limits.maxValueBytes, RESOURCE_CACHE_MAX_VALUE_BYTES)
    const entriesByHash = new Map<string, DbCacheEntry>()
    let admittedBytes = 0
    let admittedEntries = 0

    return {
        async admitOwnedBytes(bytes) {
            // A segment which cannot fit is still authoritative database input;
            // it is decoded above but never copied, hashed, or retained for the
            // disposable cache.
            if (
                bytes.byteLength > maxValueBytes
                || admittedEntries >= maxEntries
                || bytes.byteLength > maxBytes - admittedBytes
            ) {
                return null
            }

            // Reserve synchronously before hashing: array segments are handled
            // in parallel batches, so checking only after Web Crypto resolves
            // would let every member observe the same stale budget.
            admittedBytes += bytes.byteLength
            admittedEntries += 1

            // MessagePack decoding gave this miss its own immutable buffer, so
            // Web Crypto can hash it without another payload-sized copy.
            let hash: string
            try {
                hash = await sha256OwnedBytes(bytes)
            } catch (error) {
                admittedBytes -= bytes.byteLength
                admittedEntries -= 1
                throw error
            }
            const existing = entriesByHash.get(hash)
            if (existing) {
                admittedBytes -= bytes.byteLength
                admittedEntries -= 1
                return existing
            }

            const entry = { hash, bytes }
            entriesByHash.set(hash, entry)
            return entry
        },
    }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback
    if (!Number.isFinite(value) || value <= 0) return 0
    return Math.floor(value)
}

function readBytes(value: unknown): Uint8Array | null {
    // decodeRawMsgpack uses copyBuffers, so MessagePack binary values already
    // own storage independent of the envelope. Reusing that owned Uint8Array
    // preserves the existing one-copy cache-miss path instead of copying every
    // segment a second time before hashing and persistence.
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    }
    return null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value)
    return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)
}
