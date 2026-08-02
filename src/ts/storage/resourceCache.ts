import { sha256OwnedBytes } from './payloadHash'

export { formatHashBytes, sha256OwnedBytes } from './payloadHash'

export const RESOURCE_CACHE_DATABASE = 'pocketrisu-resource-cache-v1'
export const RESOURCE_CACHE_LOCAL_STORAGE_KEY = 'pocketrisu-resource-cache'
export const RESOURCE_CACHE_MAX_MANIFESTS = 512
export const RESOURCE_CACHE_MAX_HASHES_PER_MANIFEST = 4
export const RESOURCE_CACHE_MAX_DB_HASHES_PER_MANIFEST = 8192
export const RESOURCE_CACHE_MAX_ENTRIES = 32_768
export const RESOURCE_CACHE_MAX_STORED_BYTES = 64 * 1024 * 1024
export const RESOURCE_CACHE_MAX_VALUE_BYTES = 32 * 1024 * 1024
export const RESOURCE_CACHE_IO_TIMEOUT_MS = 2_000
export const RESOURCE_CACHE_PRUNE_MAX_MUTATIONS = 32
export const RESOURCE_CACHE_PRUNE_MAX_ADDED_BYTES = 8 * 1024 * 1024
export const RESOURCE_CACHE_PRUNE_MAX_DELAY_MS = 50

const RESOURCE_CACHE_DATABASE_VERSION = 1
const RESOURCE_CACHE_ENTRY_STORE = 'entries'
const RESOURCE_CACHE_MANIFEST_STORE = 'manifests'
const RESOURCE_CACHE_MANIFEST_VERSION = 1 as const
const RESOURCE_CACHE_HASH_PATTERN = /^[0-9a-f]{64}$/
const HASH_BATCH_SIZE = 32

// Manifest kind selects only an in-memory retention bound. It is not persisted.
export type ResourceCacheManifestKind = 'item' | 'database'

export interface ResourceCacheStats {
    enabled: boolean
    supported: boolean
    manifestCount: number
    entryCount: number
    totalBytes: number
}

export interface ResourceCacheByteEntry {
    hash: string
    bytes: Uint8Array
}

export interface ResourceCacheManifestUpdate {
    key: string
    hashes: readonly string[]
    entries: readonly ResourceCacheByteEntry[]
    kind: ResourceCacheManifestKind
}

interface PreparedResourceCacheManifestUpdates {
    manifests: Array<Pick<ResourceCacheManifestUpdate, 'key' | 'hashes' | 'kind'>>
    entries: Array<ResourceCacheByteEntry | null>
    entrySizes: Map<string, number>
    stagedBytes: number
}

export interface VerifiedResourceCacheManifest {
    hashes: string[]
    bytesByHash: Map<string, Uint8Array>
}

export type OwnedResourceCacheMutation =
    | { type: 'set'; resourceKey: string; hash: string; ownedBytes: Uint8Array }
    | { type: 'remove'; resourceKey: string }

export interface ResourceCachePruneDebt {
    mutations: number
    addedBytes: number
}

interface StoredResourceCacheManifest {
    version: 1
    hashes: string[]
    sizes: number[]
    updatedAt: number
}

export interface ResourceCacheManifestRecord {
    key: string
    hashes: string[]
    sizes: number[]
    updatedAt: number
}

export interface ResourceCacheRetentionPlan {
    manifests: ResourceCacheManifestRecord[]
    referencedHashes: string[]
    manifestDeletes: string[]
    entryDeletes: string[]
}

interface ResourceCacheLimits {
    maxManifests: number
    maxHashesPerManifest: number
    maxEntries: number
    maxStoredBytes: number
    maxValueBytes: number
}

const DEFAULT_LIMITS: ResourceCacheLimits = {
    maxManifests: RESOURCE_CACHE_MAX_MANIFESTS,
    maxHashesPerManifest: RESOURCE_CACHE_MAX_DB_HASHES_PER_MANIFEST,
    maxEntries: RESOURCE_CACHE_MAX_ENTRIES,
    maxStoredBytes: RESOURCE_CACHE_MAX_STORED_BYTES,
    maxValueBytes: RESOURCE_CACHE_MAX_VALUE_BYTES,
}

let resourceCacheDatabasePromise: Promise<IDBDatabase | null> | null = null
let resourceCacheWriteChain: Promise<void> = Promise.resolve()
let resourceCacheEpoch = 0
let resourceCachePruneDebt: ResourceCachePruneDebt = { mutations: 0, addedBytes: 0 }
let resourceCachePruneTimer: ReturnType<typeof setTimeout> | undefined
let resourceCachePrunePending = false

export function advanceResourceCachePruneDebt(
    current: ResourceCachePruneDebt,
    mutations: number,
    addedBytes: number,
): { debt: ResourceCachePruneDebt; prune: boolean } {
    const debt = {
        mutations: current.mutations + Math.max(0, mutations),
        addedBytes: current.addedBytes + Math.max(0, addedBytes),
    }
    const prune = debt.mutations >= RESOURCE_CACHE_PRUNE_MAX_MUTATIONS
        || debt.addedBytes >= RESOURCE_CACHE_PRUNE_MAX_ADDED_BYTES
    return { debt: prune ? { mutations: 0, addedBytes: 0 } : debt, prune }
}

/** Bound disposable cache work so it can only delay an authoritative read briefly. */
export async function settleBestEffortResourceCache<T>(
    operation: Promise<T>,
    fallback: T,
    timeoutMs = RESOURCE_CACHE_IO_TIMEOUT_MS,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            operation,
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), timeoutMs)
            }),
        ])
    } catch {
        return fallback
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/**
 * Continue after a stalled predecessor and bound the new disposable operation.
 * The returned promise always settles, so it is safe to retain as the next
 * resource-cache chain head.
 */
export function chainBestEffortResourceCacheOperation(
    predecessor: Promise<unknown>,
    operation: () => Promise<unknown>,
    timeoutMs = RESOURCE_CACHE_IO_TIMEOUT_MS,
): Promise<void> {
    return settleBestEffortResourceCache(predecessor, undefined, timeoutMs)
        .then(() => settleBestEffortResourceCache(
            Promise.resolve().then(operation),
            undefined,
            timeoutMs,
        ))
        .then(() => undefined)
}

function enqueueResourceCacheWrite(operation: () => Promise<unknown>): Promise<void> {
    const next = chainBestEffortResourceCacheOperation(
        resourceCacheWriteChain,
        operation,
    )
    resourceCacheWriteChain = next
    return next
}

function resetResourceCachePruneDebt(): void {
    resourceCachePruneDebt = { mutations: 0, addedBytes: 0 }
    if (resourceCachePruneTimer) clearTimeout(resourceCachePruneTimer)
    resourceCachePruneTimer = undefined
    resourceCachePrunePending = false
}

function scheduleDeferredResourceCachePrune(epoch: number): void {
    if (resourceCachePruneTimer || resourceCachePrunePending) return
    resourceCachePruneTimer = setTimeout(() => {
        resourceCachePruneTimer = undefined
        resourceCachePrunePending = true
        void enqueueResourceCacheWrite(async () => {
            try {
                if (epoch !== resourceCacheEpoch || !isResourceCacheEnabled()) return
                const database = await openResourceCacheDatabase()
                if (!database) return
                await pruneResourceCache(database)
            } finally {
                if (epoch === resourceCacheEpoch) {
                    resourceCachePruneDebt = { mutations: 0, addedBytes: 0 }
                    resourceCachePrunePending = false
                }
            }
        })
    }, RESOURCE_CACHE_PRUNE_MAX_DELAY_MS)
}

async function accountResourceCachePruneDebt(
    database: IDBDatabase,
    epoch: number,
    mutations: number,
    addedBytes: number,
): Promise<void> {
    const next = advanceResourceCachePruneDebt(
        resourceCachePruneDebt,
        mutations,
        addedBytes,
    )
    resourceCachePruneDebt = next.debt
    if (next.prune) {
        // A timer-fired prune already sits behind every earlier queued write,
        // including this one. Let that single scan cover the accumulated debt.
        if (resourceCachePrunePending) return
        if (resourceCachePruneTimer) clearTimeout(resourceCachePruneTimer)
        resourceCachePruneTimer = undefined
        await pruneResourceCache(database)
        return
    }
    scheduleDeferredResourceCachePrune(epoch)
}

export function isSha256Hex(value: unknown): value is string {
    return typeof value === 'string' && RESOURCE_CACHE_HASH_PATTERN.test(value)
}

export function resourceCacheManifestHashLimit(kind: ResourceCacheManifestKind): number {
    return kind === 'database'
        ? RESOURCE_CACHE_MAX_DB_HASHES_PER_MANIFEST
        : RESOURCE_CACHE_MAX_HASHES_PER_MANIFEST
}

function resourceCacheManifestKind(resourceKey: string): ResourceCacheManifestKind {
    return resourceKey.startsWith('db:') ? 'database' : 'item'
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
    const copied = new Uint8Array(bytes.byteLength)
    copied.set(bytes)
    return sha256OwnedBytes(copied)
}

export function isResourceCacheSupported(): boolean {
    try {
        return !!globalThis.crypto?.subtle
            && typeof globalThis.indexedDB !== 'undefined'
            && typeof globalThis.localStorage !== 'undefined'
    } catch {
        return false
    }
}

export function isResourceCacheEnabled(): boolean {
    if (!isResourceCacheSupported()) return false
    try {
        return globalThis.localStorage.getItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

export async function setResourceCacheEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
        try {
            globalThis.localStorage?.setItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY, 'true')
        } catch {
            // A blocked localStorage means the opt-in cannot take effect.
        }
        return
    }

    try {
        globalThis.localStorage?.removeItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY)
    } catch {
        // Clearing IndexedDB is still useful even if localStorage is blocked.
    }
    await clearResourceCache()
}

/** Return best-effort browser-cache usage without surfacing IndexedDB failures. */
export async function getResourceCacheStats(): Promise<ResourceCacheStats> {
    const empty = (): ResourceCacheStats => ({
        enabled: isResourceCacheEnabled(),
        supported: isResourceCacheSupported(),
        manifestCount: 0,
        entryCount: 0,
        totalBytes: 0,
    })

    try {
        const unavailable = empty()
        if (!unavailable.enabled || !unavailable.supported) return unavailable
        const database = await openResourceCacheDatabase()
        if (!database) return unavailable

        try {
            const transaction = database.transaction(
                [RESOURCE_CACHE_ENTRY_STORE, RESOURCE_CACHE_MANIFEST_STORE],
                'readonly',
            )
            const done = transactionComplete(transaction)
            const entries = transaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
            const manifests = transaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE)
            const [manifestCount, entryCount, totalBytes] = await Promise.all([
                requestResult(manifests.count()),
                requestResult(entries.count()),
                sumResourceCacheEntryBytes(entries.openCursor()),
            ])
            await done
            return {
                enabled: true,
                supported: true,
                manifestCount,
                entryCount,
                totalBytes,
            }
        } catch {
            discardResourceCacheDatabase(database)
            return unavailable
        }
    } catch {
        return {
            enabled: false,
            supported: false,
            manifestCount: 0,
            entryCount: 0,
            totalBytes: 0,
        }
    }
}

/** Return a de-duplicated newest-first manifest capped to a few revisions. */
export function mergeResourceManifestHashes(
    currentHashes: readonly string[],
    nextHash: string,
    limit = RESOURCE_CACHE_MAX_HASHES_PER_MANIFEST,
): string[] {
    if (!Number.isInteger(limit) || limit <= 0) return []
    const hashes: string[] = []
    const seen = new Set<string>()
    for (const hash of [nextHash, ...currentHashes]) {
        if (hashes.length >= limit) break
        if (!isSha256Hex(hash) || seen.has(hash)) continue
        hashes.push(hash)
        seen.add(hash)
    }
    return hashes
}

/** Build a bounded request inventory containing only resident content entries. */
export function selectResidentManifestHashes(
    manifestHashes: readonly string[],
    residentHashes: ReadonlySet<string>,
    limit = RESOURCE_CACHE_MAX_HASHES_PER_MANIFEST,
): string[] {
    if (!Number.isInteger(limit) || limit <= 0) return []
    const selected: string[] = []
    const seen = new Set<string>()
    for (const hash of manifestHashes) {
        if (selected.length >= limit) break
        if (!isSha256Hex(hash) || seen.has(hash) || !residentHashes.has(hash)) continue
        selected.push(hash)
        seen.add(hash)
    }
    return selected
}

/**
 * Select the newest bounded manifests and content entries. This is kept pure
 * so pruning policy can be tested without an IndexedDB implementation.
 */
export function planResourceCacheRetention(
    manifestRecords: readonly ResourceCacheManifestRecord[],
    residentEntryHashes: readonly string[],
    limitOverrides: Partial<ResourceCacheLimits> = {},
): ResourceCacheRetentionPlan {
    const limits = { ...DEFAULT_LIMITS, ...limitOverrides }
    const residents = new Set(residentEntryHashes.filter(isSha256Hex))
    const candidates = manifestRecords
        .map((manifest, index) => ({ manifest, index }))
        .sort((left, right) => {
            const updatedDifference = right.manifest.updatedAt - left.manifest.updatedAt
            return updatedDifference || left.index - right.index
        })

    const manifests: ResourceCacheManifestRecord[] = []
    const keptManifestKeys = new Set<string>()
    const referencedSizes = new Map<string, number>()
    let referencedBytes = 0

    for (const { manifest } of candidates) {
        if (manifests.length >= limits.maxManifests) break
        if (!nonEmptyString(manifest.key) || keptManifestKeys.has(manifest.key)) continue

        const hashes: string[] = []
        const sizes: number[] = []
        const manifestHashes = new Set<string>()
        const manifestHashLimit = Math.min(
            limits.maxHashesPerManifest,
            resourceCacheManifestHashLimit(resourceCacheManifestKind(manifest.key)),
        )
        for (let index = 0; index < manifest.hashes.length; index += 1) {
            if (hashes.length >= manifestHashLimit) break
            const hash = manifest.hashes[index]
            const size = manifest.sizes[index]
            if (
                !isSha256Hex(hash)
                || manifestHashes.has(hash)
                || !residents.has(hash)
                || !Number.isInteger(size)
                || size < 0
                || size > limits.maxValueBytes
            ) {
                continue
            }

            const retainedSize = referencedSizes.get(hash)
            if (retainedSize === undefined) {
                if (referencedSizes.size >= limits.maxEntries) continue
                if (referencedBytes + size > limits.maxStoredBytes) continue
                referencedSizes.set(hash, size)
                referencedBytes += size
            }
            hashes.push(hash)
            sizes.push(retainedSize ?? size)
            manifestHashes.add(hash)
        }
        if (hashes.length === 0) continue

        manifests.push({
            key: manifest.key,
            hashes,
            sizes,
            updatedAt: Number.isFinite(manifest.updatedAt) ? manifest.updatedAt : 0,
        })
        keptManifestKeys.add(manifest.key)
    }

    const referencedHashes = [...referencedSizes.keys()]
    const referencedHashSet = new Set(referencedHashes)
    return {
        manifests,
        referencedHashes,
        manifestDeletes: [...new Set(manifestRecords.map(({ key }) => key))]
            .filter((key) => !keptManifestKeys.has(key)),
        entryDeletes: [...new Set(residentEntryHashes)]
            .filter((hash) => !referencedHashSet.has(hash)),
    }
}

/** Read a manifest inventory without loading its potentially large values. */
export async function getManifestHashes(resourceKey: string): Promise<string[]> {
    if (!isResourceCacheEnabled() || !nonEmptyString(resourceKey)) return []
    const database = await openResourceCacheDatabase()
    if (!database) return []

    try {
        const manifestTransaction = database.transaction(RESOURCE_CACHE_MANIFEST_STORE, 'readonly')
        const manifestDone = transactionComplete(manifestTransaction)
        const stored = await requestResult(
            manifestTransaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE).get(resourceKey),
        )
        await manifestDone
        const manifestHashLimit = resourceCacheManifestHashLimit(resourceCacheManifestKind(resourceKey))
        const manifest = readStoredManifest(stored, manifestHashLimit)
        if (!manifest || manifest.hashes.length === 0) return []

        const entryTransaction = database.transaction(RESOURCE_CACHE_ENTRY_STORE, 'readonly')
        const entryDone = transactionComplete(entryTransaction)
        const entries = entryTransaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
        const resident = await Promise.all(
            manifest.hashes.map(async (hash) => [hash, await requestResult(entries.count(hash))] as const),
        )
        await entryDone
        return selectResidentManifestHashes(
            manifest.hashes,
            new Set(resident.filter(([, count]) => count > 0).map(([hash]) => hash)),
            manifestHashLimit,
        )
    } catch {
        discardResourceCacheDatabase(database)
        return []
    }
}

/** Load one manifest and retain only entries whose resident bytes re-hash correctly. */
export async function getVerifiedManifestSnapshot(
    resourceKey: string,
): Promise<VerifiedResourceCacheManifest | null> {
    if (!isResourceCacheEnabled() || !nonEmptyString(resourceKey)) return null
    const database = await openResourceCacheDatabase()
    if (!database) return null

    try {
        const manifestTransaction = database.transaction(RESOURCE_CACHE_MANIFEST_STORE, 'readonly')
        const manifestDone = transactionComplete(manifestTransaction)
        const stored = await requestResult(
            manifestTransaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE).get(resourceKey),
        )
        await manifestDone
        const manifest = readStoredManifest(
            stored,
            resourceCacheManifestHashLimit(resourceCacheManifestKind(resourceKey)),
        )
        if (!manifest) return { hashes: [], bytesByHash: new Map() }

        const entryTransaction = database.transaction(RESOURCE_CACHE_ENTRY_STORE, 'readonly')
        const entryDone = transactionComplete(entryTransaction)
        const entries = entryTransaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
        const storedEntries = await Promise.all(
            manifest.hashes.map(async (hash) => [hash, await requestResult(entries.get(hash))] as const),
        )
        await entryDone

        const hashes: string[] = []
        const bytesByHash = new Map<string, Uint8Array>()
        const corruptHashes: string[] = []
        for (let offset = 0; offset < storedEntries.length; offset += HASH_BATCH_SIZE) {
            const batch = storedEntries.slice(offset, offset + HASH_BATCH_SIZE)
            const verified = await Promise.all(batch.map(async ([hash, value]) => {
                const bytes = readStoredBytes(value)
                if (!bytes) return { hash, bytes: null }
                return { hash, bytes: await sha256Bytes(bytes) === hash ? bytes : null }
            }))
            for (const entry of verified) {
                if (!entry.bytes) {
                    corruptHashes.push(entry.hash)
                    continue
                }
                hashes.push(entry.hash)
                bytesByHash.set(entry.hash, entry.bytes)
            }
        }
        if (corruptHashes.length > 0) {
            void deleteResourceCacheEntries(database, corruptHashes)
        }
        return { hashes, bytesByHash }
    } catch {
        discardResourceCacheDatabase(database)
        return null
    }
}

/** Load and re-hash cached bytes before returning a defensive copy. */
export async function getVerifiedCachedBytes(hash: string): Promise<Uint8Array | null> {
    if (!isResourceCacheEnabled() || !isSha256Hex(hash)) return null
    const database = await openResourceCacheDatabase()
    if (!database) return null

    try {
        const transaction = database.transaction(RESOURCE_CACHE_ENTRY_STORE, 'readonly')
        const done = transactionComplete(transaction)
        const stored = await requestResult(transaction.objectStore(RESOURCE_CACHE_ENTRY_STORE).get(hash))
        await done
        const bytes = readStoredBytes(stored)
        if (!bytes || await sha256Bytes(bytes) !== hash) {
            await deleteResourceCacheEntry(database, hash)
            return null
        }
        return bytes
    } catch {
        discardResourceCacheDatabase(database)
        return null
    }
}

/**
 * Hash and persist authoritative wire bytes. Cache failures are swallowed;
 * hashing failures can only occur if Web Crypto disappears after enablement.
 */
export async function storeBytes(
    resourceKey: string,
    bytes: Uint8Array,
): Promise<string | null> {
    if (
        !isResourceCacheEnabled()
        || !nonEmptyString(resourceKey)
        || bytes.byteLength > RESOURCE_CACHE_MAX_VALUE_BYTES
    ) {
        return null
    }
    const copied = new Uint8Array(bytes.byteLength)
    copied.set(bytes)
    const hash = await settleBestEffortResourceCache(sha256OwnedBytes(copied), null)
    if (!hash) return null

    await applyOwnedResourceCacheMutations([{
        type: 'set',
        resourceKey,
        hash,
        ownedBytes: copied,
    }])
    return hash
}

/**
 * Persist immutable, caller-owned authoritative bytes under a server-provided
 * digest. Plugin JSON preparation creates a fresh buffer and donates it after
 * commit, so this path needs neither another full-size copy nor another hash.
 * Every cache read still re-hashes before use; a bad server digest only causes
 * a disposable cache miss.
 */
export function storeOwnedBytesWithKnownHash(
    resourceKey: string,
    hash: string,
    ownedBytes: Uint8Array,
): Promise<void> {
    if (
        !isResourceCacheEnabled()
        || !nonEmptyString(resourceKey)
        || !isSha256Hex(hash)
        || ownedBytes.byteLength > RESOURCE_CACHE_MAX_VALUE_BYTES
    ) {
        return Promise.resolve()
    }

    return applyOwnedResourceCacheMutations([{
        type: 'set', resourceKey, hash, ownedBytes,
    }])
}

/**
 * Publish a trusted mutation group with one queue slot and one IndexedDB
 * transaction. The donated set buffers are never copied or re-hashed here;
 * reads remain independently hash-verified before use.
 */
export function applyOwnedResourceCacheMutations(
    mutations: readonly OwnedResourceCacheMutation[],
): Promise<void> {
    if (!isResourceCacheEnabled()) return Promise.resolve()
    const filtered = mutations.flatMap((mutation): OwnedResourceCacheMutation[] => {
        if (!nonEmptyString(mutation.resourceKey)) return []
        if (mutation.type === 'remove') return [{ ...mutation }]
        if (!isSha256Hex(mutation.hash)
            || mutation.ownedBytes.byteLength > RESOURCE_CACHE_MAX_VALUE_BYTES) return []
        return [{ ...mutation }]
    })
    const latestByResourceKey = new Map<string, OwnedResourceCacheMutation>()
    for (const mutation of filtered) latestByResourceKey.set(mutation.resourceKey, mutation)
    const prepared = [...latestByResourceKey.values()]
    if (prepared.length === 0) return Promise.resolve()

    const epoch = resourceCacheEpoch
    return enqueueResourceCacheWrite(async () => {
        if (epoch !== resourceCacheEpoch || !isResourceCacheEnabled()) return
        const database = await openResourceCacheDatabase()
        if (!database) return
        await persistOwnedResourceCacheMutations(database, prepared)
        if (epoch !== resourceCacheEpoch || !isResourceCacheEnabled()) return
        await accountResourceCachePruneDebt(
            database,
            epoch,
            prepared.length,
            prepared.reduce((total, mutation) => total + (
                mutation.type === 'set' ? mutation.ownedBytes.byteLength : 0
            ), 0),
        )
    })
}

/** Persist several authoritative segment misses and replace their manifests. */
export function persistResourceCacheManifests(
    updates: readonly ResourceCacheManifestUpdate[],
): Promise<void> {
    if (!isResourceCacheEnabled()) return Promise.resolve()
    const prepared = prepareManifestUpdates(updates)
    if (prepared.manifests.length === 0) return Promise.resolve()

    const epoch = resourceCacheEpoch
    const operation = enqueueResourceCacheWrite(async () => {
            if (epoch !== resourceCacheEpoch || !isResourceCacheEnabled()) return
            const database = await openResourceCacheDatabase()
            if (!database) return
            await persistResourceCacheManifestUpdates(database, prepared)
            if (epoch !== resourceCacheEpoch || !isResourceCacheEnabled()) return
            await accountResourceCachePruneDebt(
                database,
                epoch,
                prepared.manifests.length,
                prepared.stagedBytes,
            )
        })
    return operation
}

/** Refresh manifest recency after a server-confirmed cache hit. */
export function touchResourceCacheManifest(resourceKey: string): Promise<void> {
    if (!isResourceCacheEnabled() || !nonEmptyString(resourceKey)) return Promise.resolve()
    const epoch = resourceCacheEpoch
    const operation = enqueueResourceCacheWrite(async () => {
            if (epoch !== resourceCacheEpoch || !isResourceCacheEnabled()) return
            const database = await openResourceCacheDatabase()
            if (!database) return
            await touchStoredManifest(database, resourceKey)
        })
    return operation
}

/** Remove cached manifests in one logical key namespace without loading them. */
export function invalidateResourceCachePrefix(resourceKeyPrefix: string): Promise<void> {
    if (!isResourceCacheEnabled() || !nonEmptyString(resourceKeyPrefix)) return Promise.resolve()
    const epoch = resourceCacheEpoch
    const operation = resourceCacheWriteChain
        .catch(() => undefined)
        .then(async () => {
            if (epoch !== resourceCacheEpoch || !isResourceCacheEnabled()) return
            const database = await openResourceCacheDatabase()
            if (!database) return
            const transaction = database.transaction(RESOURCE_CACHE_MANIFEST_STORE, 'readwrite')
            const done = transactionComplete(transaction)
            const manifests = transaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE)
            const range = IDBKeyRange.bound(resourceKeyPrefix, `${resourceKeyPrefix}\uffff`)
            const cursorRequest = manifests.openKeyCursor(range)
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result
                if (!cursor) return
                cursor.delete()
                cursor.continue()
            }
            await done
        })
        .catch(() => undefined)
    resourceCacheWriteChain = operation
    return operation
}

/** Drop one disposable manifest after an authoritative key deletion. */
export function invalidateResourceCacheManifest(resourceKey: string): Promise<void> {
    return applyOwnedResourceCacheMutations([{ type: 'remove', resourceKey }])
}

/** Clear the disposable cache, including pending connections and writes. */
export async function clearResourceCache(): Promise<void> {
    resourceCacheEpoch += 1
    resetResourceCachePruneDebt()
    await resourceCacheWriteChain.catch(() => undefined)

    const database = await resourceCacheDatabasePromise?.catch(() => null)
    database?.close()
    resourceCacheDatabasePromise = null
    resourceCacheWriteChain = Promise.resolve()

    const indexedDB = getIndexedDB()
    if (!indexedDB) return
    try {
        await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(RESOURCE_CACHE_DATABASE)
            request.onsuccess = () => resolve()
            request.onerror = () => resolve()
            request.onblocked = () => resolve()
        })
    } catch {
        // A blocked/disabled IndexedDB remains a non-authoritative cache miss.
    }
}

async function openResourceCacheDatabase(): Promise<IDBDatabase | null> {
    if (!isResourceCacheEnabled()) return null
    if (resourceCacheDatabasePromise) return resourceCacheDatabasePromise
    const indexedDB = getIndexedDB()
    if (!indexedDB) return null

    const promise = new Promise<IDBDatabase | null>((resolve) => {
        const request = indexedDB.open(RESOURCE_CACHE_DATABASE, RESOURCE_CACHE_DATABASE_VERSION)
        let settled = false
        const finish = (database: IDBDatabase | null) => {
            if (settled) {
                database?.close()
                return
            }
            settled = true
            resolve(database)
        }
        request.onupgradeneeded = () => {
            const database = request.result
            if (!database.objectStoreNames.contains(RESOURCE_CACHE_ENTRY_STORE)) {
                database.createObjectStore(RESOURCE_CACHE_ENTRY_STORE)
            }
            if (!database.objectStoreNames.contains(RESOURCE_CACHE_MANIFEST_STORE)) {
                database.createObjectStore(RESOURCE_CACHE_MANIFEST_STORE)
            }
        }
        request.onsuccess = () => {
            const database = request.result
            if (!isResourceCacheEnabled()) {
                database.close()
                finish(null)
                return
            }
            database.onversionchange = () => {
                database.close()
                resourceCacheDatabasePromise = null
            }
            finish(database)
        }
        request.onerror = () => finish(null)
        request.onblocked = () => finish(null)
    })
    resourceCacheDatabasePromise = promise
    const database = await promise
    if (!database && resourceCacheDatabasePromise === promise) {
        resourceCacheDatabasePromise = null
    }
    return database
}

async function persistOwnedResourceCacheMutations(
    database: IDBDatabase,
    mutations: readonly OwnedResourceCacheMutation[],
): Promise<void> {
    const transaction = database.transaction(
        [RESOURCE_CACHE_ENTRY_STORE, RESOURCE_CACHE_MANIFEST_STORE],
        'readwrite',
    )
    const done = transactionComplete(transaction)
    const entries = transaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
    const manifests = transaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE)
    const writtenHashes = new Set<string>()
    const updatedAt = Date.now()
    for (const mutation of mutations) {
        if (mutation.type === 'remove') {
            manifests.delete(mutation.resourceKey)
            continue
        }
        const request = manifests.get(mutation.resourceKey)
        request.onsuccess = () => {
            const current = readStoredManifest(
                request.result,
                resourceCacheManifestHashLimit(resourceCacheManifestKind(mutation.resourceKey)),
            )
            const hashes = mergeResourceManifestHashes(current?.hashes ?? [], mutation.hash)
            const currentSizes = new Map(
                (current?.hashes ?? []).map((hash, index) => [hash, current?.sizes[index] ?? 0]),
            )
            manifests.put({
                version: RESOURCE_CACHE_MANIFEST_VERSION,
                hashes,
                sizes: hashes.map(hash => hash === mutation.hash
                    ? mutation.ownedBytes.byteLength
                    : currentSizes.get(hash) ?? 0),
                updatedAt,
            } satisfies StoredResourceCacheManifest, mutation.resourceKey)
            if (!writtenHashes.has(mutation.hash)) {
                entries.put(mutation.ownedBytes, mutation.hash)
                writtenHashes.add(mutation.hash)
            }
        }
    }
    await done
}

function prepareManifestUpdates(
    updates: readonly ResourceCacheManifestUpdate[],
): PreparedResourceCacheManifestUpdates {
    const manifests: PreparedResourceCacheManifestUpdates['manifests'] = []
    const entries: Array<ResourceCacheByteEntry | null> = []
    const entrySizes = new Map<string, number>()
    let stagedBytes = 0

    for (const update of updates) {
        if (!nonEmptyString(update.key)) continue
        const hashLimit = resourceCacheManifestHashLimit(update.kind)
        const hashes: string[] = []
        const seen = new Set<string>()
        for (const hash of update.hashes) {
            if (hashes.length >= hashLimit) break
            if (!isSha256Hex(hash) || seen.has(hash)) continue
            hashes.push(hash)
            seen.add(hash)
        }
        manifests.push({ key: update.key, hashes, kind: update.kind })

        // Database boot donates immutable miss buffers. Keep one reference per
        // content hash and enforce the same aggregate limits defensively before
        // any background IndexedDB work is queued.
        const manifestHashes = new Set(hashes)
        for (const entry of update.entries) {
            if (
                !manifestHashes.has(entry.hash)
                || entrySizes.has(entry.hash)
                || !isSha256Hex(entry.hash)
                || entry.bytes.byteLength > RESOURCE_CACHE_MAX_VALUE_BYTES
                || entrySizes.size >= RESOURCE_CACHE_MAX_ENTRIES
                || entry.bytes.byteLength > RESOURCE_CACHE_MAX_STORED_BYTES - stagedBytes
            ) {
                continue
            }
            entries.push(entry)
            entrySizes.set(entry.hash, entry.bytes.byteLength)
            stagedBytes += entry.bytes.byteLength
        }
    }
    return { manifests, entries, entrySizes, stagedBytes }
}

async function persistResourceCacheManifestUpdates(
    database: IDBDatabase,
    prepared: PreparedResourceCacheManifestUpdates,
): Promise<void> {
    const transaction = database.transaction(
        [RESOURCE_CACHE_ENTRY_STORE, RESOURCE_CACHE_MANIFEST_STORE],
        'readwrite',
    )
    const done = transactionComplete(transaction)
    const entries = transaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
    const manifests = transaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE)
    const now = Date.now()

    // IndexedDB takes ownership through structured cloning at put(). Drop each
    // donated JS reference immediately instead of retaining the complete boot
    // miss set until the manifest transaction finishes.
    for (let index = 0; index < prepared.entries.length; index += 1) {
        const entry = prepared.entries[index]
        if (!entry) continue
        entries.put(entry.bytes, entry.hash)
        prepared.entries[index] = null
    }

    for (const update of prepared.manifests) {
        const request = manifests.get(update.key)
        request.onsuccess = () => {
            const current = readStoredManifest(request.result, resourceCacheManifestHashLimit(update.kind))
            const currentSizes = new Map(
                (current?.hashes ?? []).map((hash, index) => [hash, current?.sizes[index] ?? 0]),
            )
            const hashes: string[] = []
            const sizes: number[] = []
            for (const hash of update.hashes) {
                const size = prepared.entrySizes.get(hash) ?? currentSizes.get(hash)
                if (size === undefined || size > RESOURCE_CACHE_MAX_VALUE_BYTES) continue
                hashes.push(hash)
                sizes.push(size)
            }
            if (hashes.length === 0) {
                manifests.delete(update.key)
            } else {
                manifests.put({
                    version: RESOURCE_CACHE_MANIFEST_VERSION,
                    hashes,
                    sizes,
                    updatedAt: now,
                } satisfies StoredResourceCacheManifest, update.key)
            }
        }
    }
    await done
}

async function touchStoredManifest(database: IDBDatabase, resourceKey: string): Promise<void> {
    const transaction = database.transaction(RESOURCE_CACHE_MANIFEST_STORE, 'readwrite')
    const done = transactionComplete(transaction)
    const manifests = transaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE)
    const request = manifests.get(resourceKey)
    request.onsuccess = () => {
        const manifest = readStoredManifest(
            request.result,
            resourceCacheManifestHashLimit(resourceCacheManifestKind(resourceKey)),
        )
        if (!manifest) return
        manifests.put({ ...manifest, updatedAt: Date.now() }, resourceKey)
    }
    await done
}

async function pruneResourceCache(database: IDBDatabase): Promise<void> {
    const readTransaction = database.transaction(
        [RESOURCE_CACHE_ENTRY_STORE, RESOURCE_CACHE_MANIFEST_STORE],
        'readonly',
    )
    const readDone = transactionComplete(readTransaction)
    const entries = readTransaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
    const manifests = readTransaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE)
    const [manifestKeys, storedManifests, entryKeys] = await Promise.all([
        requestResult(manifests.getAllKeys()),
        requestResult(manifests.getAll()),
        requestResult(entries.getAllKeys()),
    ])
    await readDone

    const records: ResourceCacheManifestRecord[] = []
    for (let index = 0; index < manifestKeys.length; index += 1) {
        const key = manifestKeys[index]
        const manifest = typeof key === 'string'
            ? readStoredManifest(
                storedManifests[index],
                resourceCacheManifestHashLimit(resourceCacheManifestKind(key)),
            )
            : null
        if (typeof key !== 'string' || !manifest) continue
        records.push({ key, ...manifest })
    }
    const residentHashes = entryKeys.filter((key): key is string => typeof key === 'string')
    const plan = planResourceCacheRetention(records, residentHashes)
    const keptManifestKeys = new Set(plan.manifests.map(({ key }) => key))
    const referencedHashes = new Set(plan.referencedHashes)

    const writeTransaction = database.transaction(
        [RESOURCE_CACHE_ENTRY_STORE, RESOURCE_CACHE_MANIFEST_STORE],
        'readwrite',
    )
    const writeDone = transactionComplete(writeTransaction)
    const writeEntries = writeTransaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
    const writeManifests = writeTransaction.objectStore(RESOURCE_CACHE_MANIFEST_STORE)
    for (const key of manifestKeys) {
        if (typeof key !== 'string' || !keptManifestKeys.has(key)) writeManifests.delete(key)
    }
    for (const manifest of plan.manifests) {
        writeManifests.put({
            version: RESOURCE_CACHE_MANIFEST_VERSION,
            hashes: manifest.hashes,
            sizes: manifest.sizes,
            updatedAt: manifest.updatedAt,
        } satisfies StoredResourceCacheManifest, manifest.key)
    }
    for (const key of entryKeys) {
        if (typeof key !== 'string' || !referencedHashes.has(key)) writeEntries.delete(key)
    }
    await writeDone
}

async function deleteResourceCacheEntry(database: IDBDatabase, hash: string): Promise<void> {
    try {
        const transaction = database.transaction(RESOURCE_CACHE_ENTRY_STORE, 'readwrite')
        const done = transactionComplete(transaction)
        transaction.objectStore(RESOURCE_CACHE_ENTRY_STORE).delete(hash)
        await done
    } catch {
        // Corrupt cache cleanup is best-effort.
    }
}

async function deleteResourceCacheEntries(database: IDBDatabase, hashes: readonly string[]): Promise<void> {
    try {
        const transaction = database.transaction(RESOURCE_CACHE_ENTRY_STORE, 'readwrite')
        const done = transactionComplete(transaction)
        const entries = transaction.objectStore(RESOURCE_CACHE_ENTRY_STORE)
        for (const hash of hashes) entries.delete(hash)
        await done
    } catch {
        // Corrupt cache cleanup is best-effort.
    }
}

function readStoredManifest(
    value: unknown,
    hashLimit = RESOURCE_CACHE_MAX_HASHES_PER_MANIFEST,
): StoredResourceCacheManifest | null {
    if (
        !isRecord(value)
        || value.version !== RESOURCE_CACHE_MANIFEST_VERSION
        || !Array.isArray(value.hashes)
        || value.hashes.length > hashLimit
        || !value.hashes.every(isSha256Hex)
        || !Array.isArray(value.sizes)
        || value.sizes.length !== value.hashes.length
        || !value.sizes.every((size) => Number.isInteger(size) && size >= 0 && size <= RESOURCE_CACHE_MAX_VALUE_BYTES)
        || !Number.isFinite(value.updatedAt)
    ) {
        return null
    }
    return {
        version: RESOURCE_CACHE_MANIFEST_VERSION,
        hashes: [...value.hashes],
        sizes: [...value.sizes] as number[],
        updatedAt: value.updatedAt as number,
    }
}

function readStoredBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) return new Uint8Array(value)
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
    if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        return new Uint8Array(bytes)
    }
    return null
}

function getIndexedDB(): IDBFactory | null {
    try {
        return globalThis.indexedDB ?? null
    } catch {
        return null
    }
}

function discardResourceCacheDatabase(database: IDBDatabase): void {
    database.close()
    resourceCacheDatabasePromise = null
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
}

function sumResourceCacheEntryBytes(request: IDBRequest<IDBCursorWithValue | null>): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        let totalBytes = 0
        request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) {
                resolve(totalBytes)
                return
            }
            totalBytes += readStoredBytes(cursor.value)?.byteLength ?? 0
            cursor.continue()
        }
        request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'))
    })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== ''
}
