import { decodeRawMsgpack } from './rawMsgpack'
import { isSha256Hex, sha256Bytes } from './resourceCache'

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

interface ResolvedSegment {
    value: any
    hash: string
    entry: DbCacheEntry | null
}

export async function decodeAndAssembleCachedDbRead(
    encodedEnvelope: Uint8Array,
    inventory: DbCacheInventory,
    loadCachedBytes: (hash: string) => Promise<Uint8Array | null>,
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

    const root = await resolveSegment(envelope.root, new Set(inventory.root), loadCachedBytes)
    if (!isRecord(root.value)) throw new Error('Cached database root must decode to an object')
    for (const group of DB_CACHE_ARRAY_GROUPS) {
        if (Object.prototype.hasOwnProperty.call(root.value, group)) {
            throw new Error(`Cached database root unexpectedly contains ${group}`)
        }
    }

    const database = root.value
    const updates: DbCacheManifestUpdate[] = [{
        key: 'db:root',
        hashes: [root.hash],
        entries: root.entry ? [root.entry] : [],
        kind: 'database',
    }]

    for (const group of DB_CACHE_ARRAY_GROUPS) {
        const projected = envelope[group]
        if (!Array.isArray(projected)) throw new Error(`Cached database ${group} must be an array`)
        const resolved = await resolveSegmentArray(projected, new Set(inventory[group]), loadCachedBytes)
        database[group] = resolved.map(({ value }) => value)
        updates.push({
            key: `db:${group}`,
            hashes: resolved.map(({ hash }) => hash),
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
): Promise<ResolvedSegment[]> {
    const resolved: ResolvedSegment[] = []
    for (let offset = 0; offset < projected.length; offset += 32) {
        const batch = projected.slice(offset, offset + 32)
        resolved.push(...await Promise.all(
            batch.map((segment) => resolveSegment(segment, inventory, loadCachedBytes)),
        ))
    }
    return resolved
}

async function resolveSegment(
    projected: unknown,
    inventory: ReadonlySet<string>,
    loadCachedBytes: (hash: string) => Promise<Uint8Array | null>,
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
        const hash = await sha256Bytes(bytes)
        return {
            value: decodeRawMsgpack(bytes),
            hash,
            entry: { hash, bytes },
        }
    }

    throw new Error('Malformed cached database segment')
}

function readBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) return new Uint8Array(value)
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
