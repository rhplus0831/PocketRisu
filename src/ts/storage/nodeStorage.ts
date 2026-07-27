// ── NodeOnly: server-side JWT ────────────────────────────────────────────────
// Upstream uses client-side ECDSA JWT (crypto.subtle) which requires Secure
// Context (HTTPS/localhost). NodeOnly serves over HTTP, so JWT
// signing is moved to the server. The client only caches and forwards
// server-issued tokens. If upstream changes its auth flow, sync manually.
// Server counterpart: server/node/server.cjs (createServerJwt, checkAuth,
// /api/login, /api/token/refresh)
import { language } from "src/lang"
import { alertInput, waitAlert, notifyError } from "../alert"
import { decodeRisuSave, encodeRisuSaveLegacy } from "./risuSave"
import { normalizeChat, type Chat } from "./database.svelte"
import {
    DB_CACHE_GROUPS,
    DB_CACHE_MAX_HASHES,
    decodeAndAssembleCachedDbRead,
    type DbCacheInventory,
} from "./dbCachedRead"
import {
    applyOwnedResourceCacheMutations,
    getManifestHashes,
    getVerifiedManifestSnapshot,
    getVerifiedCachedBytes,
    invalidateResourceCachePrefix,
    isResourceCacheEnabled,
    isSha256Hex,
    persistResourceCacheManifests,
    sha256Bytes,
    sha256OwnedBytes,
    settleBestEffortResourceCache,
    storeBytes,
    storeOwnedBytesWithKnownHash,
    touchResourceCacheManifest,
    invalidateResourceCacheManifest,
} from "./resourceCache"
import { getThrownMessage, StorageError } from "./storageError"
import { awaitWithAbort, forwardAbortSignal, throwIfAborted } from "./abort"
import { v4 as uuidv4 } from "uuid"
import type {
    PluginStorageMutationRequest,
    PluginStorageMutationResult,
} from "./pluginStorageMutation"
import {
    classifyPluginStorageMutationAcknowledgement,
    pluginStorageTransportOutcomeUnknown,
    publishPluginStorageMutationCache,
} from "./pluginStorageMutation"
import type {
    PluginStorageBatchRequest,
    PluginStorageBatchResult,
    PluginStorageVersionedState,
} from "./pluginStorageBatch"
import {
    classifyPluginStorageBatchAcknowledgement,
    encodePluginStorageBatchRequest,
    PLUGIN_STORAGE_UUID_PATTERN,
    pluginStorageBatchTransportOutcomeUnknown,
} from "./pluginStorageBatch"
import { PLUGIN_VALUE_STREAM_THRESHOLD_BYTES } from "./pluginStorageLimits"
import type { BootInternalSnapshot } from "./bootSnapshotRecovery"
import { comparePluginStorageKeys } from "../plugins/pluginStorageRecord"

export const AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS = 15_000
/** Snapshot ingestion can legitimately stream hundreds of MiB from chunk storage. */
export const INTERNAL_SNAPSHOT_RESTORE_TIMEOUT_MS = 10 * 60_000
export const INTERNAL_SNAPSHOT_KEY_PATTERN = /^database\/dbbackup-(0|[1-9]\d*)\.bin$/
type BoundedStorageOperation = 'read' | 'list' | 'write' | 'remove' | 'transition' | 'batch'

interface AuthoritativeStorageOutcomeTracker {
    markRequestDispatched: () => void
    markDefinitiveResponse: () => void
    isRequestInFlight: () => boolean
}

function abortErrorName(error: unknown): boolean {
    return error instanceof DOMException
        ? error.name === "AbortError"
        : error instanceof Error && error.name === "AbortError"
}

/** Total availability bound for authentication, fetch, and response-body I/O. */
export async function runBoundedAuthoritativeStorageOperation<T>(
    operation: (
        signal: AbortSignal,
        outcome: AuthoritativeStorageOutcomeTracker,
    ) => Promise<T>,
    kind: BoundedStorageOperation,
    timeoutMs = AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
    externalSignal?: AbortSignal | null,
): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    let mutationRequestInFlight = false
    const stopForwardingAbort = forwardAbortSignal(externalSignal, controller)

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true
            controller.abort()
            const message = `Authoritative storage ${kind} timed out after ${timeoutMs}ms.`
            const ambiguousMutation = mutationRequestInFlight
                && (kind === "write" || kind === "remove"
                    || kind === "transition" || kind === "batch")
            reject(new StorageError(message, {
                code: ambiguousMutation
                    ? "COMMIT_OUTCOME_UNKNOWN"
                    : "STORAGE_TIMEOUT",
                retryable: !ambiguousMutation,
                commitOutcomeUnknown: ambiguousMutation,
                operation: kind,
            }))
        }, timeoutMs)
    })

    try {
        return await Promise.race([
            operation(controller.signal, {
                markRequestDispatched: () => { mutationRequestInFlight = true },
                markDefinitiveResponse: () => { mutationRequestInFlight = false },
                isRequestInFlight: () => mutationRequestInFlight,
            }),
            timeout,
        ])
    } catch (error) {
        const mutation = kind === "write" || kind === "remove"
            || kind === "transition" || kind === "batch"
        if (mutation && mutationRequestInFlight) {
            if (error instanceof StorageError && error.commitOutcomeUnknown) throw error
            throw new StorageError(
                getThrownMessage(
                    error,
                    `The authoritative storage ${kind} may have committed, but its outcome could not be confirmed.`,
                ),
                {
                    code: "COMMIT_OUTCOME_UNKNOWN",
                    retryable: false,
                    commitOutcomeUnknown: true,
                    operation: kind,
                    cause: error,
                },
            )
        }
        if (mutation && !mutationRequestInFlight) {
            if (error instanceof StorageError) throw error
            const timeoutOrAbort = timedOut || abortErrorName(error)
            throw new StorageError(
                getThrownMessage(
                    error,
                    `The authoritative storage ${kind} stopped with no mutation request in flight.`,
                ),
                {
                    code: timeoutOrAbort ? "STORAGE_TIMEOUT" : "STORAGE_TRANSPORT_ERROR",
                    retryable: true,
                    commitOutcomeUnknown: false,
                    operation: kind,
                    cause: error,
                },
            )
        }
        throw error
    } finally {
        if (timer) clearTimeout(timer)
        stopForwardingAbort()
    }
}

export type BootDatabaseReadResult =
    | { kind: 'bytes', bytes: Buffer | null }
    | { kind: 'decoded', database: Record<string, any> }

export interface StorageReadOptions {
    pluginStorageGeneration?: string
    signal?: AbortSignal | null
}

export interface PluginStorageManifestTransport {
    version: 1
    generation: string
    valueKeys: string[]
    metaKeys: string[]
}

export interface PluginStorageManifestSnapshotTransport {
    generation: string
    manifestRevision: string
    manifest: PluginStorageManifestTransport
    /** Manifest-owned rows that physically exist in the same server snapshot. */
    valueKeys: string[]
    metaKeys: string[]
}

export interface PluginStorageManifestStateTransport {
    generation: string
    manifestRevision: string
}

export interface PluginStorageViewerEntryTransport {
    key: string
    owner: string | null
    text: string
    size: number
    valueType: string
    revision: string
    contentHash: string
}

export interface PluginStorageViewerPageTransport {
    generation: string
    manifestRevision: string
    databaseRevision: string
    pageToken: string
    page: number
    pageSize: number
    pageCount: number
    total: number
    ownerFacets: { owner: string, count: number }[]
    unknownOwnerCount: number
    ownerFacetTotal: number
    entries: PluginStorageViewerEntryTransport[]
    metrics: {
        manifestParses: number
        valueReads: number
        ownerReads: number
        maxRowParses: number
    }
}

export interface PluginStorageMutationTransport {
    version: 1
    generation: string
    expectedManifest: PluginStorageManifestTransport
    nextManifest: PluginStorageManifestTransport
    writes: { storageKey: string, valueBytes: Uint8Array }[]
    deletes: string[]
}

export interface PluginStorageTransitionTransport {
    version: 1
    source: {
        optimized: boolean
        generation: string | null
        manifest: PluginStorageManifestTransport | null
    }
    database: Uint8Array
    expectedEtag?: string
}

export interface PluginStorageStagedTransitionBegin {
    version: 2
    transitionId: string
    source: PluginStorageTransitionTransport['source']
    targetOptimized: boolean
    targetGeneration: string
    rows: { storageKey: string, size: number }[]
    expectedEtag?: string
}

export interface PluginStorageStagedTransitionStatus {
    success: true
    transitionId: string
    state: 'uploading' | 'ready' | 'committed' | 'aborted'
    direction: 'externalize' | 'internalize'
    targetGeneration: string
    rows: {
        storageKey: string
        size: number
        sha256: string
        uploaded: boolean
    }[]
    uploaded: number
    total: number
    totalBytes: number
    etag?: string
}

export interface PluginStorageStagedTransitionAbortTombstone {
    success: true
    transitionId: string
    state: 'aborted'
}

const PLUGIN_TRANSITION_STATES = new Set(['uploading', 'ready', 'committed', 'aborted'])

function isPluginStorageStagedTransitionStatus(
    value: unknown,
    transitionId: string,
): value is PluginStorageStagedTransitionStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const result = value as Record<string, unknown>
    const allowedKeys = new Set([
        'success', 'transitionId', 'state', 'direction', 'targetGeneration',
        'rows', 'uploaded', 'total', 'totalBytes', 'etag',
    ])
    if (Object.keys(result).some(key => !allowedKeys.has(key))
        || result.success !== true
        || result.transitionId !== transitionId
        || typeof result.state !== 'string'
        || !PLUGIN_TRANSITION_STATES.has(result.state)
        || (result.direction !== 'externalize' && result.direction !== 'internalize')
        || typeof result.targetGeneration !== 'string'
        || !PLUGIN_STORAGE_UUID_PATTERN.test(result.targetGeneration)
        || !Array.isArray(result.rows)
        || result.rows.length > 100_000
        || !Number.isSafeInteger(result.uploaded)
        || !Number.isSafeInteger(result.total)
        || !Number.isSafeInteger(result.totalBytes)
        || (result.uploaded as number) < 0
        || (result.total as number) < 0
        || (result.totalBytes as number) < 0
        || result.total !== result.rows.length) return false
    let uploaded = 0
    let totalBytes = 0
    const storageKeys = new Set<string>()
    for (const rowValue of result.rows) {
        if (!rowValue || typeof rowValue !== 'object' || Array.isArray(rowValue)) return false
        const row = rowValue as Record<string, unknown>
        if (Object.keys(row).sort().join(',') !== 'sha256,size,storageKey,uploaded'
            || !PLUGIN_STORAGE_PREFIXES.some(prefix => (
                isCanonicalPluginStorageKey(row.storageKey, prefix)
            ))
            || !Number.isSafeInteger(row.size)
            || (row.size as number) <= 0
            || (row.size as number) > 32 * 1024 * 1024
            || typeof row.uploaded !== 'boolean'
            || !isSha256Hex(row.sha256)) return false
        if (storageKeys.has(row.storageKey as string)) return false
        storageKeys.add(row.storageKey as string)
        if (row.uploaded) uploaded += 1
        totalBytes += row.size as number
        if (!Number.isSafeInteger(totalBytes)) return false
    }
    if (result.uploaded !== uploaded || result.totalBytes !== totalBytes) return false
    const allUploaded = uploaded === result.rows.length
    if (result.state === 'committed') {
        return allUploaded
            && typeof result.etag === 'string'
            && /^[0-9a-f]{32}$/.test(result.etag)
    }
    if (result.etag !== undefined) return false
    if (result.direction === 'internalize' && !allUploaded) return false
    if (result.state === 'uploading') {
        return result.direction === 'externalize' && !allUploaded
    }
    if (result.state === 'ready') return allUploaded
    return result.state === 'aborted'
}

function isPluginStorageStagedTransitionAbortTombstone(
    value: unknown,
    transitionId: string,
): value is PluginStorageStagedTransitionAbortTombstone {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const result = value as Record<string, unknown>
    return Object.keys(result).sort().join(',') === 'state,success,transitionId'
        && result.success === true
        && result.transitionId === transitionId
        && result.state === 'aborted'
}

function normalizeStorageReadOptions(
    options: StorageReadOptions | AbortSignal | null | undefined,
): StorageReadOptions {
    if (!options) return {}
    if ('aborted' in options && 'addEventListener' in options) {
        return { signal: options as AbortSignal }
    }
    return options as StorageReadOptions
}

export interface ChatBackupSummary {
    chaId: string
    chatId: string
    versionCount: number
    newestTs: number
    oldestTs: number
    totalBytes: number
}

export interface ChatBackupVersion {
    versionId: string
    ts: number
    reason: string
    size: number
    storage: 'loose' | 'bundle'
    bundleFile?: string
}

export interface StorageCapacity {
    freeBytes: number | null
}

export interface StorageEntrySize {
    key: string
    size: number
}

// Custom error class for database conflict detection
export class ConflictError extends StorageError {
    currentEtag: string
    constructor(message: string, currentEtag: string) {
        super(message, {
            status: 409,
            code: 'STORAGE_CONFLICT',
            retryable: false,
            commitOutcomeUnknown: false,
            operation: 'write',
        })
        this.name = 'ConflictError'
        this.currentEtag = currentEtag
    }
}

type StorageOperation = 'read' | 'list' | 'write' | 'remove' | 'transition'

interface StorageFailurePayload {
    error?: unknown
    message?: unknown
    code?: unknown
    retryAfter?: unknown
    retryable?: unknown
    commitOutcome?: unknown
    commitOutcomeUnknown?: unknown
}

interface InternalSnapshotRestoreAcknowledgement {
    ok: true
    key: string
    commitOutcome: 'committed'
    commitOutcomeUnknown: false
}

function isExactInternalSnapshotRestoreAcknowledgement(
    value: unknown,
    key: string,
): value is InternalSnapshotRestoreAcknowledgement {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const result = value as Record<string, unknown>
    return Object.keys(result).sort().join(',') === 'commitOutcome,commitOutcomeUnknown,key,ok'
        && result.ok === true
        && result.key === key
        && result.commitOutcome === 'committed'
        && result.commitOutcomeUnknown === false
}

const PLUGIN_STORAGE_PREFIXES = ['pluginsave/', 'pluginsave-meta/'] as const
const PLUGIN_STORAGE_MAX_RETRIES = 2
const PLUGIN_STORAGE_DEFAULT_RETRY_SECONDS = 0.25
const PLUGIN_STORAGE_MAX_RETRY_DELAY_SECONDS = 5

function isPluginStorageTarget(target: string): boolean {
    return PLUGIN_STORAGE_PREFIXES.some(prefix => target.startsWith(prefix))
}

function parseInternalSnapshotKey(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const match = INTERNAL_SNAPSHOT_KEY_PATTERN.exec(value)
    if (!match) return null
    const snapshotTimestamp = Number(match[1])
    const timestamp = snapshotTimestamp * 100
    return Number.isSafeInteger(snapshotTimestamp)
        && snapshotTimestamp >= 0
        && Number.isSafeInteger(timestamp)
        && timestamp >= 0
        ? timestamp
        : null
}

function isCanonicalPluginStorageKey(value: unknown, prefix: string): value is string {
    if (typeof value !== 'string'
        || !value.startsWith(prefix)
        || !value.endsWith('.json')) return false
    const encoded = value.slice(prefix.length, -'.json'.length)
    if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return false
    try {
        const padded = encoded
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(encoded.length / 4) * 4, '=')
        const bytes = Buffer.from(padded, 'base64')
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const canonical = Buffer.from(decoded, 'utf-8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '')
        return canonical === encoded
    } catch {
        return false
    }
}

function parseRetryAfterSeconds(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (typeof value !== 'string' || value.trim() === '') return null
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric >= 0) return numeric
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) return null
    return Math.max(0, (timestamp - Date.now()) / 1000)
}

function payloadMessage(payload: StorageFailurePayload | null): string | null {
    if (typeof payload?.error === 'string' && payload.error.length > 0) return payload.error
    if (typeof payload?.message === 'string' && payload.message.length > 0) return payload.message
    return null
}

// Warning the server attaches to /api/patch responses when the most recent
// debounced persist failed (Stage 1 visibility — see issues.md).
export interface PersistWarning {
    timestamp: number
    message: string
    attemptedSize: number | null
    source: string
}

export interface PatchItemResult {
    success: boolean
    etag?: string
    persistWarning?: PersistWarning
    /** Set when the server's chat-internal-field guard rejected the patch. */
    chatGuardRejected?: boolean
}

const LIST_CACHE_DB_NAME = 'risu-list-cache'
const LIST_CACHE_STORE = 'lists'

interface ListCacheEntry {
    keys: string[]
    timestamp: number
    epoch: string
}

function listCacheKey(prefix: string): string {
    return `list:${prefix}`
}

async function openListCacheDb(): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(LIST_CACHE_DB_NAME, 1)
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(LIST_CACHE_STORE)) {
                request.result.createObjectStore(LIST_CACHE_STORE)
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function listCacheGet(prefix: string): Promise<ListCacheEntry | null> {
    let db: IDBDatabase | null = null
    try {
        db = await openListCacheDb()
        const transaction = db.transaction(LIST_CACHE_STORE, 'readonly')
        const result = await new Promise<unknown>((resolve, reject) => {
            const request = transaction.objectStore(LIST_CACHE_STORE).get(listCacheKey(prefix))
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        if (result && typeof result === 'object') {
            const entry = result as Partial<ListCacheEntry>
            if (Array.isArray(entry.keys)
                && entry.keys.every((key) => typeof key === 'string')
                && typeof entry.timestamp === 'number'
                && Number.isSafeInteger(entry.timestamp)
                && typeof entry.epoch === 'string') {
                return { keys: entry.keys, timestamp: entry.timestamp, epoch: entry.epoch }
            }
        }
        return null
    } catch {
        return null
    } finally {
        db?.close()
    }
}

async function listCacheSet(prefix: string, entry: ListCacheEntry): Promise<void> {
    let db: IDBDatabase | null = null
    try {
        db = await openListCacheDb()
        const transaction = db.transaction(LIST_CACHE_STORE, 'readwrite')
        transaction.objectStore(LIST_CACHE_STORE).put(entry, listCacheKey(prefix))
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
        })
    } catch {
        // The server remains authoritative; cache failures never break keys().
    } finally {
        db?.close()
    }
}

async function listCacheDelete(prefixes: readonly string[]): Promise<void> {
    let db: IDBDatabase | null = null
    try {
        db = await openListCacheDb()
        const transaction = db.transaction(LIST_CACHE_STORE, 'readwrite')
        const store = transaction.objectStore(LIST_CACHE_STORE)
        for (const prefix of prefixes) store.delete(listCacheKey(prefix))
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
        })
    } catch {
        // This cache is disposable; the server list/delta remains authoritative.
    } finally {
        db?.close()
    }
}

export class NodeStorage{
    private static readonly BULK_WRITE_CLIENT_BATCH = 20

    // Unique per page load — used for cross-device single-writer lock
    private static sessionId: string =
        crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2))

    _lastDbEtag: string | null = null
    authChecked = false
    private cachedJwt: { token: string; expiresAt: number } | null = null
    private static sessionInitialized = false
    private static sessionPending: {
        controller: AbortController
        promise: Promise<void>
    } | null = null
    private refreshPending: {
        controller: AbortController
        promise: Promise<string>
    } | null = null

    async createAuth(signal?: AbortSignal | null){
        throwIfAborted(signal)
        const now = Date.now()
        if (this.cachedJwt && this.cachedJwt.expiresAt - now > 30_000) {
            return this.cachedJwt.token
        }
        const token = await this._refreshToken(signal)
        return token
    }

    // Called once after JWT auth is confirmed. Issues a session cookie so that
    // <img src="/api/asset/..."> can be served without JS-injected headers.
    private async initSession(signal?: AbortSignal | null) {
        throwIfAborted(signal)
        if (NodeStorage.sessionInitialized) return
        let pending = NodeStorage.sessionPending
        if (pending?.controller.signal.aborted) {
            NodeStorage.sessionPending = null
            pending = null
        }
        if (!pending) {
            const controller = new AbortController()
            const created = {
                controller,
                promise: Promise.resolve() as Promise<void>,
            }
            created.promise = this._doInitSession(controller.signal).finally(() => {
                if (NodeStorage.sessionPending === created) NodeStorage.sessionPending = null
            })
            NodeStorage.sessionPending = created
            pending = created
        }
        const active = pending
        const stopForwardingAbort = forwardAbortSignal(signal, active.controller)
        const evictOnAbort = () => {
            if (NodeStorage.sessionPending === active) NodeStorage.sessionPending = null
        }
        signal?.addEventListener("abort", evictOnAbort, { once: true })
        try {
            return await awaitWithAbort(active.promise, signal)
        } finally {
            stopForwardingAbort()
            signal?.removeEventListener("abort", evictOnAbort)
        }
    }

    private async _doInitSession(signal: AbortSignal) {
        try {
            throwIfAborted(signal)
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: {
                    'risu-auth': await this.createAuth(signal),
                    'x-session-id': NodeStorage.sessionId,
                },
                signal,
            })
            await awaitWithAbort(res.arrayBuffer(), signal)
            if (res.ok) {
                NodeStorage.sessionInitialized = true
            }
            // Non-ok (400/401/500): will retry on next checkAuth() call.
        } catch (error) {
            if (signal.aborted) throw error
            // Network error: will retry on next checkAuth() call.
        }
    }

    private async _refreshToken(signal?: AbortSignal | null): Promise<string> {
        throwIfAborted(signal)
        let pending = this.refreshPending
        if (pending?.controller.signal.aborted) {
            this.refreshPending = null
            pending = null
        }
        if (!pending) {
            const controller = new AbortController()
            const created = {
                controller,
                promise: Promise.resolve("") as Promise<string>,
            }
            created.promise = this._doRefreshToken(controller.signal).finally(() => {
                if (this.refreshPending === created) this.refreshPending = null
            })
            this.refreshPending = created
            pending = created
        }
        const active = pending
        const stopForwardingAbort = forwardAbortSignal(signal, active.controller)
        const evictOnAbort = () => {
            if (this.refreshPending === active) this.refreshPending = null
        }
        signal?.addEventListener("abort", evictOnAbort, { once: true })
        try {
            return await awaitWithAbort(active.promise, signal)
        } finally {
            stopForwardingAbort()
            signal?.removeEventListener("abort", evictOnAbort)
        }
    }

    private async _doRefreshToken(signal: AbortSignal): Promise<string> {
        throwIfAborted(signal)
        const res = await fetch('/api/token/refresh', {
            method: 'POST',
            headers: { 'risu-auth': this.cachedJwt?.token ?? '' },
            signal,
        })
        if (res.ok) {
            const data = await awaitWithAbort(res.json(), signal)
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
            return data.token
        }
        await awaitWithAbort(res.arrayBuffer(), signal)
        return this.cachedJwt?.token ?? ''
    }

    private async loginWithPassword(password: string, signal: AbortSignal) {
        throwIfAborted(signal)
        const response = await fetch('/api/login', {
            method: "POST",
            body: JSON.stringify({ password }),
            headers: {
                'content-type': 'application/json'
            },
            signal,
        })

        if(response.status === 429){
            notifyError(`Too many attempts. Please wait and try again later.`)
            await awaitWithAbort(waitAlert(), signal)
            throw new Error('Too many login attempts')
        }

        if(response.status < 200 || response.status >= 300){
            let message = 'Node login failed'
            try {
                const data = await awaitWithAbort(response.json(), signal)
                message = data.error ?? message
            } catch {
                // noop
            }
            throw new Error(message)
        }

        const data = await awaitWithAbort(response.json(), signal)
        if (data.token) {
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response, signal: AbortSignal) {
        if(response.status !== 400 && response.status !== 401){
            return false
        }

        try {
            const data = await awaitWithAbort(response.clone().json(), signal)
            return [
                'No auth header',
                'Invalid Signature',
                'Token Expired'
            ].includes(data?.error)
        } catch {
            return false
        }
    }

    private async authFetch(
        input: RequestInfo | URL,
        init: RequestInit = {},
        retry = true,
        mutationOutcome?: AuthoritativeStorageOutcomeTracker,
    ) {
        const execute = async (
            signal: AbortSignal,
            outcome: AuthoritativeStorageOutcomeTracker,
        ): Promise<Response> => {
            await this.checkAuth(signal)
            const headers = new Headers(init.headers)
            headers.set('risu-auth', await this.createAuth(signal))
            headers.set('x-session-id', NodeStorage.sessionId)

            throwIfAborted(signal)
            outcome.markRequestDispatched()
            mutationOutcome?.markRequestDispatched()
            let response: Response
            try {
                response = await fetch(input, {
                    ...init,
                    headers,
                    signal,
                })
            } catch (error) {
                // No definitive HTTP response exists, so mutation ambiguity
                // intentionally remains active for the outer operation.
                throw error
            }
            outcome.markDefinitiveResponse()
            mutationOutcome?.markDefinitiveResponse()

            if (response.status === 423) {
                window.dispatchEvent(new CustomEvent('risu-session-deactivated'))
            }

            if(retry && await this.shouldRetryAuth(response, signal)){
                this.authChecked = false
                this.cachedJwt = null
                await this.checkAuth(signal)
                return this.authFetch(
                    input,
                    { ...init, signal },
                    false,
                    mutationOutcome,
                )
            }

            return response
        }

        // Storage calls already own a total-operation controller. Reuse that
        // exact signal for fetch so aborting while a response body is being
        // consumed also aborts the underlying network request. Other callers
        // still receive authFetch's ordinary bounded controller.
        if (init.signal) {
            return execute(init.signal, {
                markRequestDispatched: () => undefined,
                markDefinitiveResponse: () => undefined,
                isRequestInFlight: () => false,
            })
        }
        return runBoundedAuthoritativeStorageOperation(
            execute,
            "read",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
        )
    }

    private async parseStorageFailureResponse(
        response: Response,
        operation: StorageOperation,
        mutation: boolean,
        signal?: AbortSignal | null,
    ): Promise<StorageError> {
        let payload: StorageFailurePayload | null = null
        let responseText = ''
        const jsonResponse = response.clone()
        const textResponse = response.clone()
        try {
            const parsed = await awaitWithAbort(jsonResponse.json(), signal) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = parsed as StorageFailurePayload
            } else if (typeof parsed === 'string') {
                responseText = parsed
            }
        } catch {
            try {
                responseText = await awaitWithAbort(textResponse.text(), signal)
            } catch {
                // A status and operation still provide a useful structured error.
            }
        }

        const status = response.status
        const serverCode = typeof payload?.code === 'string' ? payload.code : null
        // Retry eligibility is a schema pair, not two independent hints. A
        // stray `commitOutcomeUnknown: false` (including on a malformed 503)
        // cannot prove rollback and must remain commit-outcome unknown.
        const explicitlyNotCommitted = payload?.commitOutcome === 'not-committed'
            && payload?.commitOutcomeUnknown === false
        const commitOutcomeUnknown = mutation
            && (payload?.commitOutcomeUnknown === true
                || payload?.commitOutcome === 'unknown'
                || ((status === 409 || status >= 500) && !explicitlyNotCommitted))
        const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'))
            ?? parseRetryAfterSeconds(payload?.retryAfter)
        const message = payloadMessage(payload)
            ?? (responseText.trim() || `${operation} failed with HTTP ${status}`)

        return new StorageError(message, {
            status,
            code: serverCode ?? (commitOutcomeUnknown ? 'COMMIT_OUTCOME_UNKNOWN' : `HTTP_${status}`),
            retryAfter,
            retryable: payload?.retryable === true,
            commitOutcomeUnknown,
            commitOutcome: explicitlyNotCommitted
                ? 'not-committed'
                : (commitOutcomeUnknown ? 'unknown' : null),
            operation,
        })
    }

    private makeStorageTransportError(
        error: unknown,
        operation: StorageOperation,
        mutation: boolean,
    ): StorageError {
        return new StorageError(
            getThrownMessage(error, `${operation} failed before a response was received`),
            {
                code: mutation ? 'COMMIT_OUTCOME_UNKNOWN' : 'STORAGE_TRANSPORT_ERROR',
                retryable: !mutation,
                commitOutcomeUnknown: mutation,
                operation,
                cause: error,
            },
        )
    }

    private async waitForPluginStorageRetry(
        error: StorageError,
        retryIndex: number,
        signal?: AbortSignal | null,
    ): Promise<void> {
        const delaySeconds = Math.min(
            error.retryAfter
                ?? PLUGIN_STORAGE_DEFAULT_RETRY_SECONDS * (2 ** retryIndex),
            PLUGIN_STORAGE_MAX_RETRY_DELAY_SECONDS,
        )
        throwIfAborted(signal)
        if (delaySeconds <= 0) return
        await awaitWithAbort(
            new Promise<void>(resolve => setTimeout(resolve, delaySeconds * 1000)),
            signal,
        )
    }

    /**
     * Plugin storage operations are idempotent at the HTTP boundary: writes
     * replace one key and removes delete one key. Retry only failures that are
     * explicitly safe, and never replay a mutation whose commit is ambiguous.
     */
    private async requestStorage(
        target: string,
        operation: StorageOperation,
        mutation: boolean,
        request: () => Promise<Response>,
        allowedStatuses: readonly number[] = [],
        signal?: AbortSignal | null,
        outcome?: AuthoritativeStorageOutcomeTracker,
    ): Promise<Response> {
        const retryPluginOperation = isPluginStorageTarget(target)
        for (let retryIndex = 0; ; retryIndex++) {
            throwIfAborted(signal)
            let response: Response
            try {
                response = await request()
            } catch (error) {
                if (signal?.aborted) throw error
                const mutationOutcomeUnknown = mutation
                    && (outcome?.isRequestInFlight() ?? true)
                const storageError = this.makeStorageTransportError(
                    error,
                    operation,
                    mutationOutcomeUnknown,
                )
                if (retryPluginOperation
                    && storageError.retryable
                    && !storageError.commitOutcomeUnknown
                    && retryIndex < PLUGIN_STORAGE_MAX_RETRIES) {
                    await this.waitForPluginStorageRetry(storageError, retryIndex, signal)
                    continue
                }
                throw storageError
            }

            if (response.ok || allowedStatuses.includes(response.status)) return response
            const storageError = await this.parseStorageFailureResponse(
                response,
                operation,
                mutation,
                signal,
            )
            if (retryPluginOperation
                && storageError.retryable
                && !storageError.commitOutcomeUnknown
                && retryIndex < PLUGIN_STORAGE_MAX_RETRIES) {
                await this.waitForPluginStorageRetry(storageError, retryIndex, signal)
                continue
            }
            throw storageError
        }
    }

    private storagePayloadError(
        payload: StorageFailurePayload,
        operation: StorageOperation,
        mutation: boolean,
        status: number,
    ): StorageError {
        const explicitlyNotCommitted = payload.commitOutcome === 'not-committed'
            && payload.commitOutcomeUnknown === false
        const commitOutcomeUnknown = mutation && !explicitlyNotCommitted
        return new StorageError(payloadMessage(payload) ?? `${operation} failed`, {
            status,
            code: typeof payload.code === 'string'
                ? payload.code
                : (commitOutcomeUnknown ? 'COMMIT_OUTCOME_UNKNOWN' : 'STORAGE_RESPONSE_ERROR'),
            retryAfter: parseRetryAfterSeconds(payload.retryAfter),
            retryable: payload.retryable === true,
            commitOutcomeUnknown,
            commitOutcome: explicitlyNotCommitted
                ? 'not-committed'
                : (commitOutcomeUnknown ? 'unknown' : null),
            operation,
        })
    }

    private async parseDatabaseConflict(
        response: Response,
        key: string,
        requestedEtag: string | undefined,
        signal?: AbortSignal | null,
    ): Promise<{ message: string; currentEtag: string } | null> {
        if (response.status !== 409
            || key !== 'database/database.bin'
            || typeof requestedEtag !== 'string'
            || requestedEtag.length === 0) {
            return null
        }
        try {
            const payload = await awaitWithAbort(response.json(), signal) as unknown
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
            const record = payload as Record<string, unknown>
            if (typeof record.error !== 'string' || record.error.length === 0) return null
            if (typeof record.currentEtag !== 'string'
                || !/^[0-9a-f]{32}$/.test(record.currentEtag)) {
                return null
            }
            return { message: record.error, currentEtag: record.currentEtag }
        } catch {
            return null
        }
    }

    private async sendPluginStorageTransaction(
        path: string,
        payload: PluginStorageMutationTransport | PluginStorageTransitionTransport,
        kind: 'write' | 'transition',
        externalSignal?: AbortSignal | null,
    ): Promise<{ etag?: string }> {
        return runBoundedAuthoritativeStorageOperation(async (signal, outcome) => {
            const response = await this.authFetch(path, {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: encodeRisuSaveLegacy(payload) as any,
                signal,
            }, true, outcome)
            const failureResponse = response.clone()
            // Keep the result ambiguous until its acknowledgement body is
            // available; an HTTP status without the transaction payload is not
            // proof of commit or rollback.
            outcome.markRequestDispatched()
            let result: any = null
            try {
                result = await awaitWithAbort(response.json(), signal)
            } catch (error) {
                throw error
            }
            if (response.status === 409) {
                outcome.markDefinitiveResponse()
                throw new ConflictError(
                    result?.error ?? 'Plugin storage transaction conflict',
                    result?.currentEtag ?? this._lastDbEtag ?? '',
                )
            }
            if (!response.ok) {
                const storageError = await this.parseStorageFailureResponse(
                    failureResponse,
                    kind,
                    true,
                    signal,
                )
                if (storageError.commitOutcomeUnknown) throw storageError
                outcome.markDefinitiveResponse()
                throw storageError
            }
            if (!result || result.success !== true) {
                throw new StorageError('Invalid plugin storage transaction acknowledgement.', {
                    code: 'COMMIT_OUTCOME_UNKNOWN',
                    retryable: false,
                    commitOutcomeUnknown: true,
                    operation: kind,
                })
            }
            outcome.markDefinitiveResponse()
            if (typeof result.etag === 'string') this._lastDbEtag = result.etag
            return result
        }, kind, AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS, externalSignal)
    }

    async commitPluginStorageMutation(
        plan: PluginStorageMutationTransport,
        signal?: AbortSignal | null,
    ): Promise<void> {
        await this.sendPluginStorageTransaction(
            '/api/plugin-storage/mutate',
            plan,
            'write',
            signal,
        )
    }

    async commitPluginStorageTransition(
        plan: PluginStorageTransitionTransport,
        signal?: AbortSignal | null,
    ): Promise<{ etag?: string }> {
        return await this.sendPluginStorageTransaction(
            '/api/plugin-storage/transition',
            plan,
            'transition',
            signal,
        )
    }

    private async stagedPluginStorageControl(
        path: string,
        transitionId: string,
        method: 'GET' | 'POST',
        body?: PluginStorageStagedTransitionBegin,
        externalSignal?: AbortSignal | null,
        mutation = false,
        allowAbortTombstone = false,
    ): Promise<PluginStorageStagedTransitionStatus | PluginStorageStagedTransitionAbortTombstone> {
        const execute = () => runBoundedAuthoritativeStorageOperation(
            async (signal, outcome) => {
                const response = await this.authFetch(path, {
                    method,
                    headers: {
                        'content-type': 'application/json',
                        'x-plugin-storage-transition': transitionId,
                    },
                    body: body ? JSON.stringify(body) : undefined,
                    signal,
                }, mutation, outcome)
                if (mutation) outcome.markRequestDispatched()
                const result = await awaitWithAbort(response.json(), signal) as any
                if (response.status === 409) {
                    if (mutation) outcome.markDefinitiveResponse()
                    throw new ConflictError(
                        result?.error ?? 'Plugin transition conflict',
                        result?.currentEtag ?? this._lastDbEtag ?? '',
                    )
                }
                if (!response.ok || result?.success !== true) {
                    const definitiveFailure = response.status < 500
                        || (result?.commitOutcome === 'not-committed'
                            && result?.commitOutcomeUnknown === false)
                    if (mutation && definitiveFailure) outcome.markDefinitiveResponse()
                    throw new StorageError(result?.error ?? 'Invalid staged transition response', {
                        status: response.status,
                        code: result?.code ?? (mutation && !definitiveFailure
                            ? 'COMMIT_OUTCOME_UNKNOWN'
                            : 'PLUGIN_STORAGE_TRANSITION_FAILED'),
                        retryable: definitiveFailure && response.status >= 500,
                        commitOutcomeUnknown: mutation && !definitiveFailure,
                        commitOutcome: result?.commitOutcome === 'not-committed'
                            && result?.commitOutcomeUnknown === false
                            ? 'not-committed'
                            : (mutation && !definitiveFailure ? 'unknown' : null),
                        operation: 'transition',
                    })
                }
                if (!isPluginStorageStagedTransitionStatus(result, transitionId)
                    && !(allowAbortTombstone
                        && isPluginStorageStagedTransitionAbortTombstone(result, transitionId))) {
                    throw new StorageError('Invalid staged transition acknowledgement', {
                        status: response.status,
                        code: mutation
                            ? 'COMMIT_OUTCOME_UNKNOWN'
                            : 'STORAGE_RESPONSE_ERROR',
                        retryable: false,
                        commitOutcomeUnknown: mutation,
                        operation: 'transition',
                    })
                }
                if (mutation) outcome.markDefinitiveResponse()
                if ('etag' in result && typeof result.etag === 'string') {
                    this._lastDbEtag = result.etag
                }
                return result
            },
            mutation ? 'transition' : 'read',
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
        try {
            return await execute()
        } catch (error) {
            if (!mutation
                || !(error instanceof StorageError)
                || !error.commitOutcomeUnknown) throw error
            // Abort is idempotent and a missing stage has one exact definitive
            // tombstone. Retry the same control once before consulting status;
            // status legitimately 404s after an already-missing abort.
            if (path.endsWith('/abort')) {
                try {
                    return await execute()
                } catch (retryError) {
                    if (!(retryError instanceof StorageError)
                        || !retryError.commitOutcomeUnknown) throw retryError
                }
            }
            let status: PluginStorageStagedTransitionStatus
            try {
                status = await this.getPluginStorageTransitionStatus(transitionId)
            } catch (statusError) {
                // Losing the original ambiguous mutation behind a status
                // timeout/404/session-reset would let the caller resume in an
                // unknown mode. Only an authoritative status body may clear
                // commitOutcomeUnknown.
                throw new StorageError(
                    'Plugin storage transition outcome could not be resolved; reload is required.',
                    {
                        code: 'COMMIT_OUTCOME_UNKNOWN',
                        retryable: false,
                        commitOutcomeUnknown: true,
                        operation: 'transition',
                        cause: new AggregateError(
                            [error, statusError],
                            'Transition mutation and status lookup both failed',
                        ),
                    },
                )
            }
            if (status.state === 'committed') return status
            // The status request is serialized behind the server mutation. A
            // non-committed result therefore proves finalize did not publish,
            // while begin/abort have themselves reached a definitive state.
            if (path.endsWith('/begin') || path.endsWith('/abort')) return status
            if (path.endsWith('/finalize')) {
                throw new StorageError('Plugin storage transition was not committed.', {
                    code: 'PLUGIN_STORAGE_TRANSITION_NOT_COMMITTED',
                    retryable: true,
                    commitOutcomeUnknown: false,
                    operation: 'transition',
                    cause: error,
                })
            }
            throw error
        }
    }

    async beginPluginStorageTransition(
        plan: PluginStorageStagedTransitionBegin,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageStagedTransitionStatus> {
        return await this.stagedPluginStorageControl(
            '/api/plugin-storage/transition/stage/begin',
            plan.transitionId,
            'POST',
            plan,
            signal,
            true,
        ) as PluginStorageStagedTransitionStatus
    }

    async uploadPluginStorageTransitionRow(
        transitionId: string,
        storageKey: string,
        bytes: Uint8Array,
        externalSignal?: AbortSignal | null,
    ): Promise<PluginStorageStagedTransitionStatus> {
        const expectedHash = await sha256OwnedBytes(bytes)
        try {
            return await runBoundedAuthoritativeStorageOperation(async (signal, outcome) => {
                const response = await this.authFetch(
                    '/api/plugin-storage/transition/stage/upload',
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/octet-stream',
                            'x-plugin-storage-transition': transitionId,
                            'x-plugin-storage-key': storageKey,
                        },
                        body: bytes as any,
                        signal,
                    },
                    true,
                    outcome,
                )
                outcome.markRequestDispatched()
                const result = await awaitWithAbort(response.json(), signal) as any
                if (!response.ok || result?.success !== true) {
                    outcome.markDefinitiveResponse()
                    throw new StorageError(result?.error ?? 'Plugin transition upload failed', {
                        status: response.status,
                        code: result?.code ?? 'PLUGIN_STORAGE_TRANSITION_UPLOAD_FAILED',
                        retryable: response.status >= 500,
                        commitOutcomeUnknown: false,
                        operation: 'transition',
                    })
                }
                if (!isPluginStorageStagedTransitionStatus(result, transitionId)) {
                    throw new StorageError('Invalid staged transition upload acknowledgement', {
                        status: response.status,
                        code: 'COMMIT_OUTCOME_UNKNOWN',
                        retryable: false,
                        commitOutcomeUnknown: true,
                        operation: 'transition',
                    })
                }
                const row = result.rows.find(entry => entry.storageKey === storageKey)
                if (!row?.uploaded
                    || row.size !== bytes.byteLength
                    || row.sha256 !== expectedHash) {
                    throw new StorageError('Staged transition upload acknowledgement did not match the row', {
                        status: response.status,
                        code: 'COMMIT_OUTCOME_UNKNOWN',
                        retryable: false,
                        commitOutcomeUnknown: true,
                        operation: 'transition',
                    })
                }
                outcome.markDefinitiveResponse()
                return result
            }, 'transition', AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS, externalSignal)
        } catch (error) {
            if (!(error instanceof StorageError) || !error.commitOutcomeUnknown) throw error
            let status: PluginStorageStagedTransitionStatus
            try {
                status = await this.getPluginStorageTransitionStatus(transitionId)
            } catch (statusError) {
                throw new StorageError(
                    'Plugin storage transition upload outcome could not be resolved.',
                    {
                        code: 'COMMIT_OUTCOME_UNKNOWN',
                        retryable: false,
                        commitOutcomeUnknown: true,
                        operation: 'transition',
                        cause: new AggregateError(
                            [error, statusError],
                            'Transition upload and status lookup both failed',
                        ),
                    },
                )
            }
            const row = status.rows.find(entry => entry.storageKey === storageKey)
            if (row?.uploaded
                && row.size === bytes.byteLength
                && row.sha256 === expectedHash) return status
            throw error
        }
    }

    async readPluginStorageTransitionRow(
        transitionId: string,
        storageKey: string,
        externalSignal?: AbortSignal | null,
    ): Promise<Buffer> {
        return await runBoundedAuthoritativeStorageOperation(async signal => {
            const response = await this.authFetch(
                '/api/plugin-storage/transition/stage/row',
                {
                    method: 'GET',
                    headers: {
                        'x-plugin-storage-transition': transitionId,
                        'x-plugin-storage-key': storageKey,
                    },
                    signal,
                },
            )
            if (!response.ok) throw new Error(`Plugin transition row read failed: ${response.status}`)
            return Buffer.from(await awaitWithAbort(response.arrayBuffer(), signal))
        }, 'read', AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS, externalSignal)
    }

    async getPluginStorageTransitionStatus(
        transitionId: string,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageStagedTransitionStatus> {
        return await this.stagedPluginStorageControl(
            '/api/plugin-storage/transition/stage/status',
            transitionId,
            'GET',
            undefined,
            signal,
        ) as PluginStorageStagedTransitionStatus
    }

    async finalizePluginStorageTransition(
        transitionId: string,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageStagedTransitionStatus> {
        return await this.stagedPluginStorageControl(
            '/api/plugin-storage/transition/stage/finalize',
            transitionId,
            'POST',
            undefined,
            signal,
            true,
        ) as PluginStorageStagedTransitionStatus
    }

    async abortPluginStorageTransition(
        transitionId: string,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageStagedTransitionStatus | PluginStorageStagedTransitionAbortTombstone> {
        return await this.stagedPluginStorageControl(
            '/api/plugin-storage/transition/stage/abort',
            transitionId,
            'POST',
            undefined,
            signal,
            true,
            true,
        )
    }

    async setItem(
        key:string,
        value:Uint8Array,
        etag?:string,
        externalSignal?: AbortSignal | null,
    ) {
        return runBoundedAuthoritativeStorageOperation(
            (signal, outcome) => this.setItemAuthoritative(
                key,
                value,
                etag,
                signal,
                outcome,
            ),
            "write",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    private async setItemAuthoritative(
        key: string,
        value: Uint8Array,
        etag: string | undefined,
        signal: AbortSignal,
        outcome: AuthoritativeStorageOutcomeTracker,
    ) {
        const shouldSeedResourceCache = isResourceCacheEnabled() && key.startsWith('pluginsave/')
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await this.requestStorage(key, 'write', true, () => this.authFetch(
            '/api/write', {
            method: "POST",
            body: value as any,
            headers,
            signal,
        }, true, outcome), [409], signal, outcome)
        if(da.status === 409){
            const conflict = await this.parseDatabaseConflict(da.clone(), key, etag, signal)
            if (conflict) {
                throw new ConflictError(conflict.message, conflict.currentEtag)
            }
            throw await this.parseStorageFailureResponse(da, 'write', true, signal)
        }
        const data = await awaitWithAbort(da.json(), signal)
        if(data.error){
            throw this.storagePayloadError(data, 'write', true, da.status)
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        if (shouldSeedResourceCache && isSha256Hex(data.hash)) {
            // persistentKv donated a fresh immutable buffer. Reuse the server's
            // exact request digest after acknowledgement, outside the key lock;
            // large values are rejected by the cache helper before any copy.
            setTimeout(() => {
                void settleBestEffortResourceCache(
                    storeOwnedBytesWithKnownHash(`kv:${key}`, data.hash, value),
                    undefined,
                )
            }, 0)
        }
    }
    async mutatePluginStorage(
        request: PluginStorageMutationRequest,
        externalSignal?: AbortSignal | null,
    ): Promise<PluginStorageMutationResult> {
        const fallback = (
            outcome: PluginStorageMutationResult['outcome'],
            error: string,
            code: string,
            retryable?: boolean,
            status: number | null = null,
            retryAfter: number | null = null,
            commitOutcomeUnknown = outcome === 'unknown',
        ): PluginStorageMutationResult => ({
            outcome,
            operation: request.operation,
            error,
            code,
            status,
            retryAfter,
            commitOutcomeUnknown,
            ...(retryable === undefined ? {} : { retryable }),
        })
        if (request.operation === 'set' && !request.valueBytes) {
            return fallback('not-committed', 'A set mutation requires value bytes.', 'INVALID_REQUEST')
        }
        const stableRequest: PluginStorageMutationRequest = request.operation === 'set'
            ? {
                ...request,
                valueBytes: request.ownedValueBytes
                    ? request.valueBytes!
                    : new Uint8Array(request.valueBytes!),
                ...(request.ownerRecordBytes
                    ? { ownerRecordBytes: new Uint8Array(request.ownerRecordBytes) }
                    : {}),
            }
            : { ...request }

        try {
            return await runBoundedAuthoritativeStorageOperation(
                (signal, outcome) => this.mutatePluginStorageAuthoritative(
                    stableRequest,
                    signal,
                    outcome,
                ),
                stableRequest.operation === 'set' ? 'write' : 'remove',
                AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
                externalSignal,
            )
        } catch (error) {
            if (error instanceof StorageError) {
                return fallback(
                    error.commitOutcomeUnknown ? 'unknown' : 'not-committed',
                    error.message,
                    error.code ?? (error.commitOutcomeUnknown
                        ? 'COMMIT_OUTCOME_UNKNOWN'
                        : 'STORAGE_TRANSPORT_ERROR'),
                    error.retryable,
                    error.status,
                    error.retryAfter,
                    error.commitOutcomeUnknown,
                )
            }
            return pluginStorageTransportOutcomeUnknown(stableRequest.operation, error)
        }
    }

    private async mutatePluginStorageAuthoritative(
        stableRequest: PluginStorageMutationRequest,
        signal: AbortSignal,
        outcome: AuthoritativeStorageOutcomeTracker,
    ): Promise<PluginStorageMutationResult> {
        throwIfAborted(signal)
        let expectedValueHash: string | undefined
        if (stableRequest.operation === 'set') {
            try {
                expectedValueHash = await sha256OwnedBytes(stableRequest.valueBytes!)
            } catch (error) {
                return {
                    outcome: 'not-committed',
                    operation: stableRequest.operation,
                    error: error instanceof Error ? error.message : String(error),
                    code: 'REQUEST_HASH_UNAVAILABLE',
                    status: null,
                    retryable: false,
                    commitOutcomeUnknown: false,
                }
            }
        }
        throwIfAborted(signal)

        for (let retryIndex = 0; ; retryIndex++) {
            const headers: Record<string, string> = {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(stableRequest.valueKey, 'utf-8').toString('hex'),
                'x-plugin-storage-operation': stableRequest.operation,
            }
            if (stableRequest.generation) {
                headers['x-plugin-storage-generation'] = stableRequest.generation
            }
            if (stableRequest.operation === 'set') {
                if (stableRequest.valueBytes!.byteLength >= PLUGIN_VALUE_STREAM_THRESHOLD_BYTES) {
                    headers['x-plugin-storage-stream'] = '1'
                }
                headers['x-plugin-storage-owner'] = Buffer.from(
                    stableRequest.owner ?? '',
                    'utf-8',
                ).toString('base64url')
                if (stableRequest.preserveOwner) {
                    headers['x-plugin-storage-owner-policy'] = 'preserve'
                } else if (stableRequest.ownerRecordBytes) {
                    headers['x-plugin-storage-owner-policy'] = 'record'
                    headers['x-plugin-storage-owner-record'] = Buffer.from(
                        stableRequest.ownerRecordBytes,
                    ).toString('base64url')
                }
            } else if (stableRequest.preserveOwner) {
                headers['x-plugin-storage-owner-policy'] = 'preserve'
            }
            const response = await this.authFetch('/api/plugin-storage/mutate', {
                method: 'POST',
                headers,
                body: (stableRequest.valueBytes ?? new Uint8Array()) as any,
                signal,
            }, true, outcome)

            // Receiving an HTTP response is not enough: keep the mutation
            // outcome ambiguous until the exact acknowledgement is consumed.
            outcome.markRequestDispatched()
            let body: unknown = null
            try {
                body = await awaitWithAbort(response.json(), signal)
            } catch (error) {
                if (signal.aborted) throw error
                // A proxy or connection failure may replace/truncate any status
                // body. Classification below treats it as outcome unknown.
            }
            const result = classifyPluginStorageMutationAcknowledgement(
                response.status,
                body,
                stableRequest.operation,
                expectedValueHash,
                parseRetryAfterSeconds(response.headers.get('retry-after')),
            )
            if (result.outcome === 'unknown') return result
            outcome.markDefinitiveResponse()

            if (result.outcome === 'not-committed'
                && result.code === 'IMPORT_IN_PROGRESS'
                && result.retryable === true
                && retryIndex < PLUGIN_STORAGE_MAX_RETRIES) {
                await this.waitForPluginStorageRetry(new StorageError(
                    result.error ?? 'Plugin storage import is in progress.',
                    {
                        status: result.status,
                        code: result.code,
                        retryAfter: result.retryAfter,
                        retryable: true,
                        commitOutcomeUnknown: false,
                        operation: stableRequest.operation,
                    },
                ), retryIndex, signal)
                continue
            }

            // Disposable cache publication must not extend the authoritative
            // key lock once the transaction has a trusted acknowledgement.
            void publishPluginStorageMutationCache(stableRequest, result, {
                enabled: isResourceCacheEnabled(),
                storeValue: async (valueKey, valueBytes) => {
                    if (result.outcome === 'committed' && isSha256Hex(result.hash)) {
                        await storeOwnedBytesWithKnownHash(`kv:${valueKey}`, result.hash, valueBytes)
                    }
                },
                invalidateValue: async (valueKey) => {
                    await invalidateResourceCacheManifest(`kv:${valueKey}`)
                },
            })
            return result
        }
    }

    async batchPluginStorage(
        request: PluginStorageBatchRequest,
        externalSignal?: AbortSignal | null,
    ): Promise<PluginStorageBatchResult> {
        const stableRequest: PluginStorageBatchRequest = {
            generation: request.generation,
            ...(request.expectedManifest
                ? {
                    expectedManifest: {
                        ...request.expectedManifest,
                        valueKeys: [...request.expectedManifest.valueKeys],
                        metaKeys: [...request.expectedManifest.metaKeys],
                    },
                }
                : {}),
            ...(request.expectedManifestRevision
                ? { expectedManifestRevision: request.expectedManifestRevision }
                : {}),
            operations: request.operations.map(operation => operation.operation === 'set'
                ? {
                    ...operation,
                    valueBytes: operation.ownedValueBytes
                        ? operation.valueBytes
                        : new Uint8Array(operation.valueBytes),
                }
                : { ...operation }),
        }
        try {
            return await runBoundedAuthoritativeStorageOperation(
                (signal, outcome) => this.batchPluginStorageAuthoritative(
                    stableRequest,
                    signal,
                    outcome,
                ),
                'batch',
                AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
                externalSignal,
            )
        } catch (error) {
            if (error instanceof StorageError) {
                return {
                    outcome: error.commitOutcomeUnknown ? 'unknown' : 'not-committed',
                    operation: 'batch',
                    code: error.code ?? (error.commitOutcomeUnknown
                        ? 'COMMIT_OUTCOME_UNKNOWN'
                        : 'STORAGE_TRANSPORT_ERROR'),
                    error: error.message,
                    retryable: error.commitOutcomeUnknown ? false : error.retryable,
                    status: error.status,
                    ...(error.commitOutcomeUnknown
                        ? { commitOutcomeUnknown: true as const }
                        : {
                            retryAfter: error.retryAfter,
                            commitOutcomeUnknown: false as const,
                        }),
                } as PluginStorageBatchResult
            }
            return pluginStorageBatchTransportOutcomeUnknown(error)
        }
    }

    private async batchPluginStorageAuthoritative(
        request: PluginStorageBatchRequest,
        signal: AbortSignal,
        outcome: AuthoritativeStorageOutcomeTracker,
    ): Promise<PluginStorageBatchResult> {
        throwIfAborted(signal)
        const requestBytes = encodePluginStorageBatchRequest(request)
        const requestHash = await sha256OwnedBytes(requestBytes)
        throwIfAborted(signal)

        for (let retryIndex = 0; ; retryIndex++) {
            const response = await this.authFetch('/api/plugin-storage/batch', {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream' },
                body: requestBytes as any,
                signal,
            }, true, outcome)

            // Header receipt does not acknowledge the transaction; retain the
            // ambiguous phase through complete, schema-bound body consumption.
            outcome.markRequestDispatched()
            let body: unknown = null
            try {
                body = await awaitWithAbort(response.json(), signal)
            } catch (error) {
                if (signal.aborted) throw error
            }
            const result = classifyPluginStorageBatchAcknowledgement(
                response.status,
                body,
                requestHash,
                request.operations,
                parseRetryAfterSeconds(response.headers.get('retry-after')),
            )
            if (result.outcome === 'unknown') return result
            outcome.markDefinitiveResponse()

            if (result.outcome === 'not-committed'
                && result.code === 'IMPORT_IN_PROGRESS'
                && result.retryable
                && retryIndex < PLUGIN_STORAGE_MAX_RETRIES) {
                await this.waitForPluginStorageRetry(new StorageError(result.error, {
                    status: result.status,
                    code: result.code,
                    retryAfter: result.retryAfter,
                    retryable: true,
                    commitOutcomeUnknown: false,
                    operation: 'batch',
                }), retryIndex, signal)
                continue
            }

            if (result.outcome === 'committed' && isResourceCacheEnabled()) {
                void settleBestEffortResourceCache(
                    applyOwnedResourceCacheMutations(request.operations.map((operation, index) => {
                    const valueKey = `${PLUGIN_STORAGE_PREFIXES[0]}${Buffer.from(
                        operation.key,
                        'utf-8',
                    ).toString('base64url')}.json`
                    if (operation.operation === 'set') {
                        return {
                            type: 'set' as const,
                            resourceKey: `kv:${valueKey}`,
                            hash: result.revisions[index].valueHash!,
                            ownedBytes: operation.valueBytes,
                        }
                    }
                    return { type: 'remove' as const, resourceKey: `kv:${valueKey}` }
                })),
                    undefined,
                )
            }
            return result
        }
    }

    async getPluginStorageState(
        valueKey: string,
        readOptions: StorageReadOptions | AbortSignal | null = {},
    ): Promise<PluginStorageVersionedState> {
        const options = normalizeStorageReadOptions(readOptions)
        return runBoundedAuthoritativeStorageOperation(
            signal => this.getPluginStorageStateAuthoritative(
                valueKey,
                signal,
                options.pluginStorageGeneration,
            ),
            'read',
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            options.signal,
        )
    }

    private async getPluginStorageStateAuthoritative(
        valueKey: string,
        signal: AbortSignal,
        pluginStorageGeneration?: string,
    ): Promise<PluginStorageVersionedState> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(valueKey, 'utf-8').toString('hex'),
        }
        if (pluginStorageGeneration) {
            headers['x-plugin-storage-generation'] = pluginStorageGeneration
        }
        const response = await this.requestStorage(
            valueKey,
            'read',
            false,
            () => this.authFetch('/api/plugin-storage/state', {
                method: 'GET',
                headers,
                signal,
            }),
            [],
            signal,
        )
        const body = await awaitWithAbort(response.json(), signal) as unknown
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new StorageError('Plugin storage state response was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'read', retryable: true,
            })
        }
        const record = body as Record<string, unknown>
        const allowed = new Set(['success', 'missing', 'value', 'revision', 'generation'])
        if (Object.keys(record).some(key => !allowed.has(key))
            || record.success !== true
            || typeof record.missing !== 'boolean'
            || (record.revision !== null
                && (typeof record.revision !== 'string'
                    || !/^sha256:[0-9a-f]{64}$/.test(record.revision)))
            || (record.generation !== null
                && (typeof record.generation !== 'string'
                    || !PLUGIN_STORAGE_UUID_PATTERN.test(record.generation)))) {
            throw new StorageError('Plugin storage state response was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'read', retryable: true,
            })
        }
        if (record.missing === true) {
            if (record.value !== undefined
                || record.revision !== null
                || record.generation !== null) {
                throw new StorageError('Missing plugin storage state included a value.', {
                    code: 'STORAGE_RESPONSE_ERROR', operation: 'read', retryable: true,
                })
            }
            return {
                missing: true,
                valueBytes: null,
                revision: null,
                generation: null,
            }
        }
        if (typeof record.value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.value)) {
            throw new StorageError('Plugin storage state value was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'read', retryable: true,
            })
        }
        const valueBytes = new Uint8Array(Buffer.from(record.value, 'base64'))
        if (Buffer.from(valueBytes).toString('base64') !== record.value || record.revision === null) {
            throw new StorageError('Plugin storage state value was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'read', retryable: true,
            })
        }
        return {
            missing: false,
            valueBytes,
            revision: record.revision as string,
            generation: record.generation as string | null,
        }
    }

    async getPluginStorageManifestSnapshot(
        generation: string,
        externalSignal?: AbortSignal | null,
    ): Promise<PluginStorageManifestSnapshotTransport> {
        return runBoundedAuthoritativeStorageOperation(
            signal => this.getPluginStorageManifestSnapshotAuthoritative(generation, signal),
            'list',
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    async getPluginStorageViewerPage(
        generation: string,
        options: {
            page: number
            pageSize: number
            keyQuery?: string
            ownerQuery?: string
            unknownOwner?: boolean
        },
        externalSignal?: AbortSignal | null,
        onProgress?: (completed: number, total: number) => void,
    ): Promise<PluginStorageViewerPageTransport> {
        return runBoundedAuthoritativeStorageOperation(
            signal => this.getPluginStorageViewerPageAuthoritative(
                generation,
                options,
                signal,
                onProgress,
            ),
            'list',
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    private async getPluginStorageViewerPageAuthoritative(
        generation: string,
        options: {
            page: number
            pageSize: number
            keyQuery?: string
            ownerQuery?: string
            unknownOwner?: boolean
        },
        signal: AbortSignal,
        onProgress?: (completed: number, total: number) => void,
    ): Promise<PluginStorageViewerPageTransport> {
        if (typeof generation !== 'string' || generation.length === 0) {
            throw new TypeError('Plugin storage generation must be a non-empty string')
        }
        if (!Number.isInteger(options.page) || options.page < 0) {
            throw new RangeError('Plugin storage viewer page must be a non-negative integer')
        }
        if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50) {
            throw new RangeError('Plugin storage viewer page size must be between 1 and 50')
        }
        if ((options.ownerQuery !== undefined && options.unknownOwner)
            || (options.ownerQuery !== undefined && !options.ownerQuery.isWellFormed())) {
            throw new TypeError('Plugin storage viewer owner filter is invalid')
        }
        const query = new URLSearchParams({
            page: String(options.page),
            pageSize: String(options.pageSize),
        })
        if (options.keyQuery) query.set('key', options.keyQuery)
        if (options.ownerQuery !== undefined) query.set('owner', options.ownerQuery)
        if (options.unknownOwner) query.set('unknownOwner', '1')
        const response = await this.requestStorage(
            'plugin-storage/viewer-page',
            'list',
            false,
            () => this.authFetch(`/api/plugin-storage/viewer-page?${query.toString()}`, {
                method: 'GET',
                headers: {
                    accept: 'application/x-ndjson',
                    'x-plugin-storage-generation': generation,
                },
                signal,
            }),
            [],
            signal,
        )
        if (!response.body) {
            throw new StorageError('Plugin storage viewer response omitted its body.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
            })
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let buffer = ''
        let meta: Omit<PluginStorageViewerPageTransport, 'entries' | 'pageToken' | 'metrics'> | null = null
        let done: Pick<PluginStorageViewerPageTransport, 'pageToken' | 'metrics'> | null = null
        const entries: PluginStorageViewerEntryTransport[] = []
        const seenKeys = new Set<string>()
        const textEncoder = new TextEncoder()
        const malformed = () => new StorageError('Plugin storage viewer response was malformed.', {
            code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
        })
        const exactKeys = (record: Record<string, unknown>, expected: readonly string[]) => (
            Object.keys(record).length === expected.length
            && expected.every(key => Object.hasOwn(record, key))
        )
        const parseLine = (line: string) => {
            let value: unknown
            try {
                value = JSON.parse(line)
            } catch {
                throw malformed()
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed()
            const record = value as Record<string, unknown>
            if (record.event === 'meta') {
                const ownerFacets = record.ownerFacets
                const validOwnerFacets = Array.isArray(ownerFacets)
                    && ownerFacets.every((facet, index) => {
                        if (!facet || typeof facet !== 'object' || Array.isArray(facet)) return false
                        const candidate = facet as Record<string, unknown>
                        return exactKeys(candidate, ['owner', 'count'])
                            && typeof candidate.owner === 'string'
                            && candidate.owner.length > 0
                            && candidate.owner.isWellFormed()
                            && Number.isSafeInteger(candidate.count)
                            && (candidate.count as number) > 0
                            && (index === 0
                                || (ownerFacets[index - 1] as { owner: string }).owner < candidate.owner)
                    })
                const facetCount = validOwnerFacets
                    ? ownerFacets.reduce((sum, facet) => sum + (facet as { count: number }).count, 0)
                    : -1
                if (meta || done || entries.length > 0 || !exactKeys(record, [
                    'event', 'version', 'generation', 'manifestRevision', 'databaseRevision',
                    'page', 'pageSize', 'pageCount', 'total', 'ownerFacets',
                    'unknownOwnerCount', 'ownerFacetTotal',
                ])
                    || record.version !== 1
                    || record.generation !== generation
                    || typeof record.manifestRevision !== 'string'
                    || !/^sha256:[0-9a-f]{64}$/.test(record.manifestRevision)
                    || typeof record.databaseRevision !== 'string'
                    || !/^[0-9a-f]{32}$/.test(record.databaseRevision)
                    || !Number.isSafeInteger(record.page) || (record.page as number) < 0
                    || !Number.isSafeInteger(record.pageSize)
                    || (record.pageSize as number) < 1 || (record.pageSize as number) > 50
                    || !Number.isSafeInteger(record.pageCount) || (record.pageCount as number) < 1
                    || !Number.isSafeInteger(record.total) || (record.total as number) < 0
                    || !validOwnerFacets
                    || !Number.isSafeInteger(record.unknownOwnerCount)
                    || (record.unknownOwnerCount as number) < 0
                    || !Number.isSafeInteger(record.ownerFacetTotal)
                    || !Number.isSafeInteger(facetCount)
                    || record.ownerFacetTotal !== facetCount + (record.unknownOwnerCount as number)
                    || record.pageSize !== options.pageSize
                    || record.pageCount !== Math.max(1, Math.ceil(
                        (record.total as number) / (record.pageSize as number),
                    ))
                    || record.page !== Math.min(options.page, (record.pageCount as number) - 1)
                    || (options.unknownOwner && record.total !== record.unknownOwnerCount)
                    || (options.ownerQuery !== undefined && record.total !== (
                        (ownerFacets as Array<{ owner: string, count: number }>)
                            .find(facet => facet.owner === options.ownerQuery)?.count ?? 0
                    ))
                    || (!options.unknownOwner && options.ownerQuery === undefined
                        && record.total !== record.ownerFacetTotal)) {
                    throw malformed()
                }
                meta = {
                    generation,
                    manifestRevision: record.manifestRevision,
                    databaseRevision: record.databaseRevision,
                    page: record.page as number,
                    pageSize: record.pageSize as number,
                    pageCount: record.pageCount as number,
                    total: record.total as number,
                    ownerFacets: (ownerFacets as Array<{ owner: string, count: number }>)
                        .map(facet => ({ ...facet })),
                    unknownOwnerCount: record.unknownOwnerCount as number,
                    ownerFacetTotal: record.ownerFacetTotal as number,
                }
                onProgress?.(0, Math.min(meta.pageSize, Math.max(0, meta.total - meta.page * meta.pageSize)))
                return
            }
            if (record.event === 'entry') {
                if (!meta || done || !exactKeys(record, [
                    'event', 'key', 'owner', 'text', 'size', 'valueType', 'revision', 'contentHash',
                ])
                    || typeof record.key !== 'string' || !record.key.isWellFormed()
                    || (record.owner !== null
                        && (typeof record.owner !== 'string'
                            || record.owner.length === 0
                            || !record.owner.isWellFormed()))
                    || typeof record.text !== 'string'
                    || !Number.isSafeInteger(record.size) || (record.size as number) < 0
                    || textEncoder.encode(record.text as string).byteLength !== record.size
                    || typeof record.valueType !== 'string'
                    || !['object', 'array', 'string', 'number', 'boolean', 'empty'].includes(record.valueType)
                    || typeof record.revision !== 'string'
                    || !/^sha256:[0-9a-f]{64}$/.test(record.revision)
                    || typeof record.contentHash !== 'string'
                    || !/^sha256:[0-9a-f]{64}$/.test(record.contentHash)
                    || entries.length >= meta.pageSize
                    || seenKeys.has(record.key)
                    || (entries.length > 0
                        && comparePluginStorageKeys(entries[entries.length - 1].key, record.key) >= 0)
                    || (options.keyQuery
                        && !record.key.toLowerCase().includes(options.keyQuery.trim().toLowerCase()))
                    || (options.unknownOwner && record.owner !== null)
                    || (options.ownerQuery !== undefined && record.owner !== options.ownerQuery)) {
                    throw malformed()
                }
                seenKeys.add(record.key)
                entries.push({
                    key: record.key,
                    owner: record.owner as string | null,
                    text: record.text,
                    size: record.size as number,
                    valueType: record.valueType,
                    revision: record.revision,
                    contentHash: record.contentHash,
                })
                onProgress?.(entries.length, Math.min(
                    meta.pageSize,
                    Math.max(0, meta.total - meta.page * meta.pageSize),
                ))
                return
            }
            if (record.event === 'done') {
                const metrics = record.metrics as Record<string, unknown> | undefined
                if (!meta || done || !exactKeys(record, ['event', 'pageToken', 'metrics'])
                    || typeof record.pageToken !== 'string'
                    || !/^sha256:[0-9a-f]{64}$/.test(record.pageToken)
                    || !metrics || Array.isArray(metrics)
                    || !exactKeys(metrics, [
                        'manifestParses', 'valueReads', 'ownerReads', 'maxRowParses',
                    ])
                    || !Object.values(metrics).every(value => (
                        Number.isSafeInteger(value) && (value as number) >= 0
                    ))) {
                    throw malformed()
                }
                done = {
                    pageToken: record.pageToken,
                    metrics: metrics as PluginStorageViewerPageTransport['metrics'],
                }
                return
            }
            if (record.event === 'error'
                && meta
                && !done
                && exactKeys(record, ['event', 'message'])
                && typeof record.message === 'string'
                && record.message.length > 0
                && record.message.isWellFormed()) {
                throw new StorageError(record.message, {
                    code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
                })
            }
            throw malformed()
        }

        try {
            while (true) {
                throwIfAborted(signal)
                const chunk = await awaitWithAbort(reader.read(), signal)
                if (chunk.done) break
                buffer += decoder.decode(chunk.value, { stream: true })
                let newline = buffer.indexOf('\n')
                while (newline >= 0) {
                    const line = buffer.slice(0, newline)
                    buffer = buffer.slice(newline + 1)
                    parseLine(line)
                    newline = buffer.indexOf('\n')
                }
            }
            buffer += decoder.decode()
            if (buffer) parseLine(buffer)
        } catch (error) {
            void reader.cancel(error).catch(() => undefined)
            throw error
        }
        if (!meta || !done
            || entries.length !== Math.min(
                meta.pageSize,
                Math.max(0, meta.total - meta.page * meta.pageSize),
            )
            || done.metrics.manifestParses !== 1
            || done.metrics.valueReads !== entries.length
            || done.metrics.ownerReads < 0
            || done.metrics.ownerReads > entries.length
            || done.metrics.maxRowParses !== (entries.length > 0 ? 1 : 0)) {
            throw malformed()
        }
        for (const entry of entries) {
            throwIfAborted(signal)
            const expectedContentHash = `sha256:${await sha256OwnedBytes(
                textEncoder.encode(JSON.stringify([
                    entry.key,
                    entry.owner,
                    entry.text,
                    entry.size,
                    entry.valueType,
                    entry.revision,
                ])),
            )}`
            throwIfAborted(signal)
            if (entry.contentHash !== expectedContentHash) throw malformed()
        }
        throwIfAborted(signal)
        // Canonical JSON arrays preserve string boundaries even when a key or
        // owner filter contains U+0000; delimiter concatenation cannot.
        const pageTokenMaterial = JSON.stringify([
            'pocketrisu-plugin-storage-viewer-page-v2',
            generation,
            meta.manifestRevision,
            meta.databaseRevision,
            meta.page,
            meta.pageSize,
            options.keyQuery?.trim() ?? '',
            options.ownerQuery ?? null,
            options.unknownOwner ?? false,
            meta.ownerFacets.map(facet => [facet.owner, facet.count]),
            meta.unknownOwnerCount,
            entries.map(entry => [entry.key, entry.contentHash]),
        ])
        const expectedPageToken = `sha256:${await sha256OwnedBytes(
            textEncoder.encode(pageTokenMaterial),
        )}`
        throwIfAborted(signal)
        if (done.pageToken !== expectedPageToken) throw malformed()
        throwIfAborted(signal)
        return { ...meta, ...done, entries }
    }

    async getPluginStorageManifestState(
        generation: string,
        externalSignal?: AbortSignal | null,
    ): Promise<PluginStorageManifestStateTransport> {
        return runBoundedAuthoritativeStorageOperation(
            signal => this.getPluginStorageManifestStateAuthoritative(generation, signal),
            'list',
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    private async getPluginStorageManifestStateAuthoritative(
        generation: string,
        signal: AbortSignal,
    ): Promise<PluginStorageManifestStateTransport> {
        if (typeof generation !== 'string' || generation.length === 0) {
            throw new TypeError('Plugin storage generation must be a non-empty string')
        }
        const response = await this.requestStorage(
            'plugin-storage/manifest',
            'list',
            false,
            () => this.authFetch('/api/plugin-storage/manifest', {
                method: 'GET',
                headers: {
                    'x-plugin-storage-generation': generation,
                    'x-plugin-storage-manifest-mode': 'state',
                },
                signal,
            }),
            [],
            signal,
        )
        const body = await awaitWithAbort(response.json(), signal) as unknown
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new StorageError('Plugin storage manifest state was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
            })
        }
        const record = body as Record<string, unknown>
        if (Object.keys(record).length !== 3
            || record.success !== true
            || record.generation !== generation
            || typeof record.manifestRevision !== 'string'
            || !/^sha256:[0-9a-f]{64}$/.test(record.manifestRevision)) {
            throw new StorageError('Plugin storage manifest state was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
            })
        }
        return { generation, manifestRevision: record.manifestRevision }
    }

    private async getPluginStorageManifestSnapshotAuthoritative(
        generation: string,
        signal: AbortSignal,
    ): Promise<PluginStorageManifestSnapshotTransport> {
        if (typeof generation !== 'string' || generation.length === 0) {
            throw new TypeError('Plugin storage generation must be a non-empty string')
        }
        const response = await this.requestStorage(
            'plugin-storage/manifest',
            'list',
            false,
            () => this.authFetch('/api/plugin-storage/manifest', {
                method: 'GET',
                headers: { 'x-plugin-storage-generation': generation },
                signal,
            }),
            [],
            signal,
        )
        const body = await awaitWithAbort(response.json(), signal) as unknown
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new StorageError('Plugin storage manifest response was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
            })
        }
        const record = body as Record<string, unknown>
        const manifest = record.manifest as Record<string, unknown> | undefined
        const allowed = new Set([
            'success', 'generation', 'manifestRevision', 'manifest', 'valueKeys', 'metaKeys',
        ])
        const validKeys = (value: unknown, prefix: string): value is string[] => (
            Array.isArray(value)
            && value.every(key => isCanonicalPluginStorageKey(key, prefix))
            && new Set(value).size === value.length
        )
        const manifestValueKeys = Array.isArray(manifest?.valueKeys)
            ? new Set(manifest.valueKeys as string[])
            : null
        const manifestMetaKeys = Array.isArray(manifest?.metaKeys)
            ? new Set(manifest.metaKeys as string[])
            : null
        if (Object.keys(record).some(key => !allowed.has(key))
            || record.success !== true
            || record.generation !== generation
            || typeof record.manifestRevision !== 'string'
            || !/^sha256:[0-9a-f]{64}$/.test(record.manifestRevision)
            || !manifest
            || Array.isArray(manifest)
            || Object.keys(manifest).length !== 4
            || manifest.version !== 1
            || manifest.generation !== generation
            || !validKeys(manifest.valueKeys, PLUGIN_STORAGE_PREFIXES[0])
            || !validKeys(manifest.metaKeys, PLUGIN_STORAGE_PREFIXES[1])
            || !validKeys(record.valueKeys, PLUGIN_STORAGE_PREFIXES[0])
            || !validKeys(record.metaKeys, PLUGIN_STORAGE_PREFIXES[1])
            || !(record.valueKeys as string[]).every(key => manifestValueKeys?.has(key))
            || !(record.metaKeys as string[]).every(key => manifestMetaKeys?.has(key))) {
            throw new StorageError('Plugin storage manifest response was malformed.', {
                code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
            })
        }
        return {
            generation,
            manifestRevision: record.manifestRevision,
            manifest: {
                version: 1,
                generation,
                valueKeys: [...manifest.valueKeys as string[]],
                metaKeys: [...manifest.metaKeys as string[]],
            },
            valueKeys: [...record.valueKeys as string[]],
            metaKeys: [...record.metaKeys as string[]],
        }
    }

    async getItem(
        key:string,
        readOptions: StorageReadOptions | AbortSignal | null = {},
    ):Promise<Buffer> {
        const options = normalizeStorageReadOptions(readOptions)
        return runBoundedAuthoritativeStorageOperation(
            signal => this.getItemAuthoritative(
                key,
                signal,
                options.pluginStorageGeneration,
            ),
            "read",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            options.signal,
        )
    }

    private async getItemAuthoritative(
        key: string,
        signal: AbortSignal,
        pluginStorageGeneration?: string,
    ): Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (pluginStorageGeneration) {
            headers['x-plugin-storage-generation'] = pluginStorageGeneration
        }

        const da = await this.requestStorage(key, 'read', false, () => (
            this.authFetch('/api/read', { method: "GET", headers, signal })
        ), [], signal)

        // Capture ETag for database.bin
        const etag = da.headers.get('x-db-etag')
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await awaitWithAbort(da.arrayBuffer(), signal))
        if (data.length === 0){
            return null
        }

        return data
    }

    async getItemCached(
        key: string,
        readOptions: StorageReadOptions | AbortSignal | null = {},
    ): Promise<Buffer | null> {
        const options = normalizeStorageReadOptions(readOptions)
        return runBoundedAuthoritativeStorageOperation(
            signal => this.getItemCachedAuthoritative(
                key,
                signal,
                options.pluginStorageGeneration,
            ),
            "read",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            options.signal,
        )
    }

    private async getItemCachedAuthoritative(
        key: string,
        signal: AbortSignal,
        pluginStorageGeneration?: string,
    ): Promise<Buffer | null> {
        if (!isResourceCacheEnabled() || key === 'database/database.bin') {
            return await this.getItemAuthoritative(key, signal, pluginStorageGeneration)
        }

        const resourceKey = `kv:${key}`
        let manifestHashes: string[] = []
        try {
            // Validators are manifest metadata. Do not load and re-hash every
            // retained historical body merely to ask which version is current;
            // the selected hash is verified once below when the server returns
            // a 204 cache selection.
            manifestHashes = await settleBestEffortResourceCache(
                getManifestHashes(resourceKey),
                [],
            )
        } catch {
            // Cache failures degrade to the ordinary read below.
        }

        const plainHeaders: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex'),
        }
        if (pluginStorageGeneration) {
            plainHeaders['x-plugin-storage-generation'] = pluginStorageGeneration
        }
        const headers: Record<string, string> = { ...plainHeaders }
        if (manifestHashes.length > 0) {
            headers['x-cached-hashes'] = manifestHashes.join(',')
        }

        let response = await this.requestStorage(key, 'read', false, () => (
            this.authFetch('/api/read', { method: 'GET', headers, signal })
        ), [], signal)
        if (response.status === 204) {
            try {
                const contentHash = response.headers.get('x-content-hash')
                if (!isSha256Hex(contentHash) || !manifestHashes.includes(contentHash)) {
                    throw new Error('Invalid cached KV response')
                }
                const cachedBytes = await settleBestEffortResourceCache(
                    getVerifiedCachedBytes(contentHash),
                    null,
                )
                if (!cachedBytes) throw new Error('Cached KV bytes are unavailable')
                void touchResourceCacheManifest(resourceKey)
                return cachedBytes.byteLength === 0 ? null : Buffer.from(cachedBytes)
            } catch {
                response = await this.requestStorage(key, 'read', false, () => (
                    this.authFetch('/api/read', { method: 'GET', headers: plainHeaders, signal })
                ), [], signal)
            }
        }

        const bytes = Buffer.from(await awaitWithAbort(response.arrayBuffer(), signal))
        if (bytes.length === 0) return null
        void storeBytes(resourceKey, bytes).catch(() => {
            // IndexedDB, quota, and Web Crypto anomalies are non-authoritative.
        })
        return bytes
    }

    async readDatabaseForBoot(): Promise<BootDatabaseReadResult> {
        if (!isResourceCacheEnabled()) {
            return { kind: 'bytes', bytes: await this.readRawDatabaseForBoot() }
        }

        try {
            const inventory = Object.fromEntries(
                DB_CACHE_GROUPS.map((group) => [group, []]),
            ) as DbCacheInventory
            const residentBytes = new Map<string, Uint8Array>()
            let remainingHashes = DB_CACHE_MAX_HASHES
            for (const group of DB_CACHE_GROUPS) {
                const snapshot = await getVerifiedManifestSnapshot(`db:${group}`)
                if (!snapshot) throw new Error('Database resource cache is unavailable')
                const selected = snapshot.hashes.slice(0, remainingHashes)
                inventory[group] = selected
                remainingHashes -= selected.length
                for (const hash of selected) {
                    const bytes = snapshot.bytesByHash.get(hash)
                    if (!bytes) throw new Error('Verified database cache entry is unavailable')
                    residentBytes.set(hash, bytes)
                }
            }

            const response = await this.authFetch('/api/db/read-cached', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ cache: { version: 1, hashes: inventory } }),
            })
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`cached database read error: ${response.status}`)
            }
            const responseEtag = response.headers.get('x-db-etag')
            if (!responseEtag) throw new Error('Cached database response is missing its ETag')

            const encodedEnvelope = new Uint8Array(await response.arrayBuffer())
            const assembled = await decodeAndAssembleCachedDbRead(
                encodedEnvelope,
                inventory,
                async (hash) => residentBytes.get(hash) ?? null,
            )
            if (assembled.etag !== responseEtag) {
                throw new Error('Cached database response ETag mismatch')
            }
            this._lastDbEtag = responseEtag
            await persistResourceCacheManifests(assembled.updates)
            return { kind: 'decoded', database: assembled.database }
        } catch {
            // The boot-only raw read intentionally does not decode or externalize
            // database.bin on the server. A corrupt live monolith must still
            // reach bootstrap so it can select an internal snapshot and route
            // that snapshot through the server's atomic restore transaction.
            return { kind: 'bytes', bytes: await this.readRawDatabaseForBoot() }
        }
    }

    private async readRawDatabaseForBoot(
        externalSignal?: AbortSignal | null,
    ): Promise<Buffer | null> {
        return runBoundedAuthoritativeStorageOperation(async (signal) => {
            const response = await this.requestStorage(
                'database/database.bin',
                'read',
                false,
                () => this.authFetch('/api/db/read-raw-for-boot', {
                    method: 'GET',
                    signal,
                }),
                [404],
                signal,
            )
            if (response.status === 404) {
                this._lastDbEtag = null
                return null
            }
            const bytes = Buffer.from(await awaitWithAbort(response.arrayBuffer(), signal))
            const responseEtag = response.headers.get('x-db-etag')
            this._lastDbEtag = responseEtag && /^[0-9a-f]{32}$/.test(responseEtag)
                ? responseEtag
                : null
            return bytes.length === 0 ? null : bytes
        }, 'read', AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS, externalSignal)
    }

    /**
     * List exact internal recovery keys without enumerating the generic KV
     * namespace. The response is deliberately metadata-only: bootstrap must
     * submit candidates to the server validation boundary instead of reading
     * and decoding folded snapshot bodies in browser memory.
     */
    async listInternalSnapshotsForBoot(
        externalSignal?: AbortSignal | null,
    ): Promise<BootInternalSnapshot[]> {
        return runBoundedAuthoritativeStorageOperation(async (signal) => {
            const response = await this.requestStorage(
                'database/dbbackup-',
                'list',
                false,
                () => this.authFetch('/api/db/snapshots', {
                    method: 'GET',
                    signal,
                }),
                [],
                signal,
            )
            const body = await awaitWithAbort(response.json(), signal) as unknown
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                throw new StorageError('Internal snapshot list response was malformed.', {
                    code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
                })
            }
            const record = body as Record<string, unknown>
            if (Object.keys(record).length !== 1 || !Array.isArray(record.snapshots)) {
                throw new StorageError('Internal snapshot list response was malformed.', {
                    code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
                })
            }
            const snapshots: BootInternalSnapshot[] = []
            let previousTimestamp = Number.POSITIVE_INFINITY
            const seen = new Set<string>()
            for (const value of record.snapshots) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    throw new StorageError('Internal snapshot list response was malformed.', {
                        code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
                    })
                }
                const snapshot = value as Record<string, unknown>
                const keyTimestamp = parseInternalSnapshotKey(snapshot.key)
                if (Object.keys(snapshot).sort().join(',') !== 'key,size,timestamp'
                    || keyTimestamp === null
                    || !Number.isSafeInteger(snapshot.size)
                    || (snapshot.size as number) < 0
                    || !Number.isSafeInteger(snapshot.timestamp)
                    || (snapshot.timestamp as number) < 0
                    || (snapshot.timestamp as number) > previousTimestamp
                    || seen.has(snapshot.key as string)) {
                    throw new StorageError('Internal snapshot list response was malformed.', {
                        code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
                    })
                }
                if (keyTimestamp !== snapshot.timestamp) {
                    throw new StorageError('Internal snapshot list response was malformed.', {
                        code: 'STORAGE_RESPONSE_ERROR', operation: 'list', retryable: true,
                    })
                }
                seen.add(snapshot.key as string)
                previousTimestamp = snapshot.timestamp as number
                snapshots.push({
                    key: snapshot.key as string,
                    size: snapshot.size as number,
                    timestamp: snapshot.timestamp as number,
                })
            }
            return snapshots
        }, 'list', AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS, externalSignal)
    }

    /**
     * Publish one internal snapshot through the server's exclusive restore
     * transaction. Boot recovery and Settings deliberately share this exact
     * session-fenced boundary. The request is never replayed: once dispatched,
     * a missing or malformed acknowledgement is commit-outcome unknown and the
     * caller must reload/reconcile authoritative state.
     */
    async restoreInternalSnapshot(
        key: string,
        externalSignal?: AbortSignal | null,
    ): Promise<'committed'> {
        if (parseInternalSnapshotKey(key) === null) {
            throw new TypeError('Invalid internal snapshot key')
        }
        return runBoundedAuthoritativeStorageOperation<'committed'>(async (signal, outcome) => {
            // Retrying an expired-auth response would replay the restore POST.
            // Authentication is completed before dispatch, so one attempt is
            // the only safe mutation policy.
            const response = await this.authFetch('/api/db/snapshots/restore', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ key }),
                signal,
            }, false, outcome)

            // The active-session middleware rejects 423 before the restore
            // route can run. Classify it from headers immediately: its optional
            // diagnostic body may be delayed or truncated by a proxy, but that
            // cannot make a mutation which never entered the route ambiguous.
            if (response.status === 423) {
                outcome.markDefinitiveResponse()
                try {
                    void response.body?.cancel().catch(() => undefined)
                } catch {
                    // Body disposal is best-effort and never changes the known
                    // not-committed outcome.
                }
                throw new StorageError('Session deactivated', {
                    status: 423,
                    code: 'HTTP_423',
                    retryable: false,
                    commitOutcomeUnknown: false,
                    operation: 'transition',
                })
            }
            // authFetch knows only that an HTTP response started. Keep the
            // restore ambiguous until its complete, strict JSON envelope has
            // been consumed. A proxy-generated 2xx, a mismatched echo, or a
            // truncated body after COMMIT cannot become an acknowledgement.
            outcome.markRequestDispatched()
            let payload: unknown
            try {
                const body = await awaitWithAbort(response.text(), signal)
                payload = JSON.parse(body)
            } catch (error) {
                throw new StorageError('Snapshot restore acknowledgement was truncated or malformed', {
                    status: response.status,
                    code: 'COMMIT_OUTCOME_UNKNOWN',
                    retryable: false,
                    commitOutcomeUnknown: true,
                    operation: 'transition',
                    cause: error,
                })
            }

            if (!response.ok) {
                const failure = payload && typeof payload === 'object' && !Array.isArray(payload)
                    ? payload as StorageFailurePayload
                    : null
                const explicitlyNotCommitted = failure?.commitOutcome === 'not-committed'
                    && failure?.commitOutcomeUnknown === false
                // Authentication/session/key rejection happens before the
                // mutation transaction. Server 5xx is definitive only when its
                // rollback envelope says so exactly.
                const rejectedBeforeMutation = response.status === 400
                    || response.status === 401
                    || response.status === 403
                    || response.status === 404
                    || response.status === 423
                const definitive = explicitlyNotCommitted || rejectedBeforeMutation
                if (definitive) outcome.markDefinitiveResponse()
                throw new StorageError(
                    payloadMessage(failure) ?? `Snapshot restore failed with HTTP ${response.status}`,
                    {
                        status: response.status,
                        code: typeof failure?.code === 'string'
                            ? failure.code
                            : (definitive ? `HTTP_${response.status}` : 'COMMIT_OUTCOME_UNKNOWN'),
                        retryAfter: parseRetryAfterSeconds(failure?.retryAfter),
                        retryable: definitive && failure?.retryable === true,
                        commitOutcomeUnknown: !definitive,
                        commitOutcome: explicitlyNotCommitted
                            ? 'not-committed'
                            : (!definitive ? 'unknown' : null),
                        operation: 'transition',
                    },
                )
            }

            if (response.status !== 200
                || !isExactInternalSnapshotRestoreAcknowledgement(payload, key)) {
                throw new StorageError('Snapshot restore returned an invalid commit acknowledgement', {
                    status: response.status,
                    code: 'COMMIT_OUTCOME_UNKNOWN',
                    retryable: false,
                    commitOutcomeUnknown: true,
                    operation: 'transition',
                })
            }
            outcome.markDefinitiveResponse()
            this._lastDbEtag = null
            void listCacheDelete([''])
            for (const group of DB_CACHE_GROUPS) {
                void invalidateResourceCacheManifest(`db:${group}`)
            }
            return 'committed'
        }, 'transition', INTERNAL_SNAPSHOT_RESTORE_TIMEOUT_MS, externalSignal)
    }
    async keys(prefix: string = '', externalSignal?: AbortSignal | null):Promise<string[]>{
        return runBoundedAuthoritativeStorageOperation(
            signal => this.keysAuthoritative(prefix, signal),
            "list",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    async getStorageCapacity(
        externalSignal?: AbortSignal | null,
    ): Promise<StorageCapacity> {
        return runBoundedAuthoritativeStorageOperation(
            signal => this.getStorageCapacityAuthoritative(signal),
            "read",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    async listEntriesWithSizes(
        prefix: string,
        externalSignal?: AbortSignal | null,
    ): Promise<StorageEntrySize[]> {
        return runBoundedAuthoritativeStorageOperation(
            signal => this.listEntriesWithSizesAuthoritative(prefix, signal),
            "list",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    private async listEntriesWithSizesAuthoritative(
        prefix: string,
        signal: AbortSignal,
    ): Promise<StorageEntrySize[]> {
        const response = await this.authFetch('/api/storage/list-sizes', {
            method: 'GET',
            headers: { 'key-prefix': prefix },
            signal,
        })
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`storage size inventory error: ${response.status}`)
        }
        const data = await awaitWithAbort(response.json(), signal)
        if (!Array.isArray(data?.content)
            || !data.content.every((entry: unknown) => {
                if (!entry || typeof entry !== 'object') return false
                const candidate = entry as Partial<StorageEntrySize>
                return typeof candidate.key === 'string'
                    && Number.isSafeInteger(candidate.size)
                    && (candidate.size ?? -1) >= 0
            })) {
            throw new Error('Invalid storage size inventory response')
        }
        return data.content
    }

    private async getStorageCapacityAuthoritative(
        signal: AbortSignal,
    ): Promise<StorageCapacity> {
        const response = await this.authFetch('/api/storage/capacity', {
            method: 'GET',
            signal,
        })
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`storage capacity error: ${response.status}`)
        }
        const data = await awaitWithAbort(response.json(), signal)
        if (data?.freeBytes !== null
            && (!Number.isSafeInteger(data?.freeBytes) || data.freeBytes < 0)) {
            throw new Error('Invalid storage capacity response')
        }
        return { freeBytes: data.freeBytes }
    }

    private async keysAuthoritative(prefix: string, signal: AbortSignal): Promise<string[]> {
        const headers: Record<string, string> = {}
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        const cached = await settleBestEffortResourceCache(listCacheGet(prefix), null)
        if (cached) {
            headers['x-last-sync'] = String(cached.timestamp)
            headers['x-list-epoch'] = cached.epoch
        }
        const da = await this.requestStorage(prefix, 'list', false, () => this.authFetch('/api/list', {
            method: "GET",
            headers,
            signal,
        }), [], signal)
        const data = await awaitWithAbort(da.json(), signal)
        if(data.error){
            throw this.storagePayloadError(data, 'list', false, da.status)
        }

        const serverTimestamp = data.timestamp
        const serverEpoch = data.epoch
        if (data.mode === 'delta'
            && cached
            && serverEpoch === cached.epoch
            && Array.isArray(data.added)
            && Array.isArray(data.deleted)) {
            const added = new Set<string>(data.added)
            const deleted = new Set<string>(data.deleted)
            const merged = cached.keys.filter((key) => !deleted.has(key) && !added.has(key))
            merged.push(...added)
            if (Number.isSafeInteger(serverTimestamp) && typeof serverEpoch === 'string') {
                void listCacheSet(prefix, { keys: merged, timestamp: serverTimestamp, epoch: serverEpoch })
            }
            return merged
        }

        if (!Array.isArray(data.content)) {
            throw new Error('Invalid list response')
        }
        const content = data.content as string[]
        if (Number.isSafeInteger(serverTimestamp) && typeof serverEpoch === 'string') {
            void listCacheSet(prefix, { keys: content, timestamp: serverTimestamp, epoch: serverEpoch })
        }
        return content
    }
    async removeItem(key:string, externalSignal?: AbortSignal | null){
        return runBoundedAuthoritativeStorageOperation(
            (signal, outcome) => this.removeItemAuthoritative(
                key,
                signal,
                outcome,
            ),
            "remove",
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    private async removeItemAuthoritative(
        key: string,
        signal: AbortSignal,
        outcome: AuthoritativeStorageOutcomeTracker,
    ) {
        const da = await this.requestStorage(key, 'remove', true, () => this.authFetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            },
            signal,
        }, true, outcome), [], signal, outcome)
        const data = await awaitWithAbort(da.json(), signal)
        if(data.error){
            throw this.storagePayloadError(data, 'remove', true, da.status)
        }
    }

    /** Atomically clear the complete optimized save value + owner namespace. */
    async clearPluginSaveStorage(
        externalSignal?: AbortSignal | null,
    ): Promise<'committed'> {
        return runBoundedAuthoritativeStorageOperation(
            (signal, outcome) => this.clearPluginSaveStorageAuthoritative(signal, outcome),
            'remove',
            AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
            externalSignal,
        )
    }

    private async clearPluginSaveStorageAuthoritative(
        signal: AbortSignal,
        outcome: AuthoritativeStorageOutcomeTracker,
    ): Promise<'committed'> {
        const response = await this.requestStorage(
            PLUGIN_STORAGE_PREFIXES[0],
            'remove',
            true,
            () => this.authFetch(
                '/api/plugin-storage/clear',
                { method: 'POST', signal },
                true,
                outcome,
            ),
            [],
            signal,
            outcome,
        )

        // A 2xx response alone is not the clear transaction's commit
        // acknowledgement. Keep the outcome ambiguous until the exact body
        // envelope below has been consumed and validated.
        outcome.markRequestDispatched()
        let payload: StorageFailurePayload & { success?: unknown } = {}
        try {
            const parsed = await awaitWithAbort(response.clone().json(), signal) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = parsed as StorageFailurePayload & { success?: unknown }
            }
        } catch {
            // A successful HTTP status without the commit envelope is not an
            // acknowledgement: the proxy may have replaced the response after
            // the transaction ran.
        }

        if (payload.success !== true
            || payload.commitOutcome !== 'committed'
            || payload.commitOutcomeUnknown !== false) {
            throw new StorageError('Plugin storage clear returned an invalid commit acknowledgement', {
                status: response.status,
                code: 'COMMIT_OUTCOME_UNKNOWN',
                retryable: false,
                commitOutcomeUnknown: true,
                operation: 'remove',
            })
        }
        outcome.markDefinitiveResponse()

        // A committed whole-namespace clear invalidates both cached key lists
        // and any hash-addressed plugin manifests. Cache cleanup is
        // best-effort and never changes the authoritative acknowledgement.
        void listCacheDelete(['', ...PLUGIN_STORAGE_PREFIXES])
        void invalidateResourceCachePrefix(`kv:${PLUGIN_STORAGE_PREFIXES[0]}`)
        void invalidateResourceCachePrefix(`kv:${PLUGIN_STORAGE_PREFIXES[1]}`)
        return 'committed'
    }

    private async checkAuth(signal: AbortSignal){
        throwIfAborted(signal)

        if(!this.authChecked){
            const authResponse = await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': this.cachedJwt?.token ?? ''
                },
                signal,
            })
            const data = await awaitWithAbort(authResponse.json(), signal)

            if(data.status === 'unset'){
                const password = await awaitWithAbort(
                    alertInput(language.setNodePassword),
                    signal,
                )
                const input = await digestPassword(password, signal)
                throwIfAborted(signal)
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    },
                    signal,
                })

                if(response.status < 200 || response.status >= 300){
                    await awaitWithAbort(response.arrayBuffer(), signal)
                    throw new Error('Failed to set node password')
                }
                await awaitWithAbort(response.arrayBuffer(), signal)

                await this.loginWithPassword(input, signal)
                await this.initSession(signal)
                return
            }
            else if(data.status === 'incorrect'){
                const password = await awaitWithAbort(
                    alertInput(language.inputNodePassword),
                    signal,
                )
                const input = await digestPassword(password, signal)
                await this.loginWithPassword(input, signal)
                await this.initSession(signal)
                return
            }
            else{
                if (data.token) {
                    this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
                }
                this.authChecked = true
            }
        }
        await this.initSession(signal)
    }

    listItem = this.keys

    /** Set cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        const da = await this.authFetch('/api/patch', {
            method: "POST",
            body: JSON.stringify(patchData),
            headers: {
                'content-type': 'application/json',
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })

        if (da.status === 409) {
            const data = await da.json()
            const currentEtag = data.currentEtag as string | undefined
            if (key === 'database/database.bin' && currentEtag) {
                this._lastDbEtag = currentEtag
            }
            // Server signals chat-guard rejection via explicit fields. The
            // error string fallback is kept for forward-compat with deployed
            // servers that haven't shipped the explicit fields yet.
            const rejectedByChatGuard = data.chatGuardRejected === true
                || data.code === 'CHAT_GUARD_REJECTED'
                || (typeof data.error === 'string' && data.error.includes('chat-internal field ops'))
            return { success: false, etag: currentEtag, chatGuardRejected: rejectedByChatGuard }
        }
        if (da.status < 200 || da.status >= 300) {
            return { success: false }
        }
        const data = await da.json()
        if (data.error) {
            return { success: false }
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        const persistWarning = data.persistWarning as PersistWarning | undefined
        return { success: true, etag: nextEtag, persistWarning }
    }

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        const da = await this.authFetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'accept': 'application/octet-stream'
            }
        })
        if (da.status < 200 || da.status >= 300) throw 'getItems Error'

        const ct = da.headers.get('content-type') || ''
        if (ct.includes('application/octet-stream')) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            const buf = Buffer.from(await da.arrayBuffer())
            let offset = 0
            const count = buf.readUInt32BE(offset); offset += 4
            const results: {key: string, value: Buffer}[] = []
            for (let i = 0; i < count; i++) {
                const keyLen = buf.readUInt32BE(offset); offset += 4
                const key = buf.subarray(offset, offset + keyLen).toString('utf-8'); offset += keyLen
                const valLen = buf.readUInt32BE(offset); offset += 4
                const value = buf.subarray(offset, offset + valLen) as Buffer; offset += valLen
                results.push({ key, value })
            }
            return results
        }

        // Fallback: JSON+base64
        const results: {key: string, value: string}[] = await da.json()
        return results.map(r => ({ key: r.key, value: Buffer.from(r.value, 'base64') }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const body = batch.map(e => ({
                key: e.key,
                value: Buffer.from(e.value).toString('base64')
            }))
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'content-type': 'application/json'
                }
            })
            if (da.status < 200 || da.status >= 300) throw 'setItems Error'
        }
    }

    async exportBackup(
        opts?: {
            target?: 'upstream'
            scope?: 'partial'
            signal?: AbortSignal | null
            onPreparationProgress?: (progress: {
                phase: string
                current: number
                total: number
                bytes: number
            }) => void
        },
        externalSignal?: AbortSignal | null,
    ): Promise<Response> {
        const callerSignal = externalSignal ?? opts?.signal
        throwIfAborted(callerSignal)

        if (opts?.scope === 'partial') {
            // The client chooses the stable id before POST so a lost create
            // acknowledgement can still be cancelled deterministically.
            let jobId: string | null = uuidv4()
            const boundedJson = async <T>(url: string, init: RequestInit = {}): Promise<{
                response: Response
                body: T
            }> => runBoundedAuthoritativeStorageOperation(
                async (signal) => {
                    const response = await this.authFetch(url, { ...init, signal })
                    const body = await awaitWithAbort(response.json(), signal) as T
                    return { response, body }
                },
                'read',
                AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
                callerSignal,
            )
            const cancelJob = async () => {
                if (!jobId) return
                // Cleanup must not inherit an already-aborted caller signal.
                const cleanupController = new AbortController()
                const cleanupTimer = setTimeout(() => cleanupController.abort(), 2_000)
                try {
                    await this.authFetch(`/api/backup/export/jobs/${encodeURIComponent(jobId)}`, {
                        method: 'DELETE',
                        signal: cleanupController.signal,
                    }).catch(() => {})
                } finally {
                    clearTimeout(cleanupTimer)
                }
            }

            try {
                const created = await boundedJson<{
                    jobId?: string
                    error?: string
                }>('/api/backup/export/jobs', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ scope: 'partial', jobId }),
                })
                if (!created.response.ok || typeof created.body.jobId !== 'string') {
                    throw new Error(created.body.error || `backup export prepare error: ${created.response.status}`)
                }
                jobId = created.body.jobId

                while (true) {
                    throwIfAborted(callerSignal)
                    const statusResult = await boundedJson<{
                        state?: string
                        phase?: string
                        current?: number
                        total?: number
                        bytes?: number
                        error?: string
                    }>(`/api/backup/export/jobs/${encodeURIComponent(jobId)}`)
                    if (!statusResult.response.ok) {
                        throw new Error(statusResult.body.error || `backup export status error: ${statusResult.response.status}`)
                    }
                    const status = statusResult.body
                    opts?.onPreparationProgress?.({
                        phase: typeof status.phase === 'string' ? status.phase : 'preparing',
                        current: Number(status.current ?? 0),
                        total: Number(status.total ?? 0),
                        bytes: Number(status.bytes ?? 0),
                    })
                    if (status.state === 'ready') break
                    if (status.state === 'failed' || status.state === 'cancelled') {
                        throw new Error(status.error || `Partial backup export ${status.state}`)
                    }
                    await awaitWithAbort(
                        new Promise<void>(resolve => setTimeout(resolve, 250)),
                        callerSignal,
                    )
                }

                // This request only opens an already-prepared private spool.
                // Its lifetime belongs to the caller (including body reads),
                // not the generic 15-second authoritative-read deadline.
                const downloadUrl = `/api/backup/export/jobs/${encodeURIComponent(jobId)}/download`
                const response = callerSignal
                    ? await this.authFetch(downloadUrl, { signal: callerSignal })
                    : await this.authFetch(downloadUrl)
                if (!response.ok) {
                    throw new Error(`backup export download error: ${response.status}`)
                }
                return response
            } catch (error) {
                await cancelJob()
                throw error
            }
        }

        const params = new URLSearchParams()
        if (opts?.target === 'upstream') params.set('target', 'upstream')
        const query = params.toString()
        const url = `/api/backup/export${query ? `?${query}` : ''}`
        // Backup preparation can legitimately take longer than ordinary KV
        // reads. Keep it caller-cancellable without applying the generic 15s
        // pre-header timeout.
        const da = callerSignal
            ? await this.authFetch(url, { signal: callerSignal })
            : await this.authFetch(url)
        if (da.status < 200 || da.status >= 300) throw `backup export error: ${da.status}`
        return da
    }

    async prepareImport(size: number): Promise<void> {
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status === 413) throw new Error('Backup file is too large')
        if (da.status === 507) {
            const body = await da.json().catch(() => ({}))
            const avail = body.available != null ? ` (available: ${Math.round(body.available / 1024 / 1024)} MB)` : ''
            throw new Error(`Insufficient disk space${avail}`)
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`backup prepare error: ${da.status}`)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)
            // Opt into NDJSON streaming so the server keeps the response socket
            // alive during long post-upload work — prevents reverse-proxy 502s.
            xhr.setRequestHeader('accept', 'application/x-ndjson')

            let uploadComplete = false
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }
            xhr.upload.onload = () => { uploadComplete = true }

            let parsedIndex = 0
            let leftover = ''
            let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null
            let serverErrorMsg: string | null = null

            const drainNdjson = () => {
                const text = xhr.responseText
                if (text.length <= parsedIndex) return
                leftover += text.slice(parsedIndex)
                parsedIndex = text.length
                const lines = leftover.split('\n')
                leftover = lines.pop() ?? ''
                for (const line of lines) {
                    if (!line) continue
                    let msg: any
                    try { msg = JSON.parse(line) } catch { continue }
                    if (msg.type === 'progress' && uploadComplete) {
                        // After upload finishes, surface server-side processing
                        // progress through the same callback for UI continuity.
                        onProgress?.(msg.bytes, msg.totalBytes)
                    } else if (msg.type === 'done') {
                        result = msg
                    } else if (msg.type === 'error') {
                        serverErrorMsg = typeof msg.message === 'string' ? msg.message : 'backup import failed'
                    }
                    // Ignore 'heartbeat' and unknown event types.
                }
            }

            xhr.onprogress = drainNdjson
            xhr.onerror = () => reject(new Error('backup import request failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `backup import error: ${xhr.status}`
                    try {
                        const body = JSON.parse(xhr.responseText)
                        if (body?.error) msg = String(body.error)
                    } catch {}
                    reject(new Error(msg))
                    return
                }
                drainNdjson()
                if (serverErrorMsg) reject(new Error(serverErrorMsg))
                else if (result) resolve(result)
                else reject(new Error('backup import: no result received'))
            }

            xhr.send(file)
        })
    }

    // ── Server-side backup ─────────────────────────────────────────────────────

    async saveServerBackup(
        onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, filename: string, size: number}> {
        const da = await this.authFetch('/api/backup/server/save', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup save error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, filename: string, size: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.current, msg.total, msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup: no result received')
        return result
    }

    async listServerBackups(): Promise<{backups: Array<{filename: string, size: number, createdAt: number}>}> {
        const da = await this.authFetch('/api/backup/server/list')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup list error: ${da.status}`)
        return da.json()
    }

    async restoreServerBackup(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        const da = await this.authFetch('/api/backup/server/restore', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup restore error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup restore: no result received')
        return result
    }

    async deleteServerBackup(filename: string): Promise<void> {
        const da = await this.authFetch(`/api/backup/server/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup delete error: ${da.status}`)
    }

    async downloadServerBackup(filename: string): Promise<Response> {
        const da = await this.authFetch(`/api/backup/server/download/${encodeURIComponent(filename)}`)
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup download error: ${da.status}`)
        return da
    }

    // ── Chat backups ──────────────────────────────────────────────────────────

    async listChatBackupChats(): Promise<{chats: ChatBackupSummary[]}> {
        const da = await this.authFetch('/api/chat-backups')
        if (da.status < 200 || da.status >= 300) throw new Error(`chat backup list error: ${da.status}`)
        return da.json()
    }

    async listChatBackupVersions(
        chaId: string,
        chatId: string,
    ): Promise<{versions: ChatBackupVersion[]}> {
        const da = await this.authFetch(
            `/api/chat-backups/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`
        )
        if (da.status < 200 || da.status >= 300) throw new Error(`chat backup version list error: ${da.status}`)
        return da.json()
    }

    async fetchChatBackupVersion(
        chaId: string,
        chatId: string,
        versionId: string,
    ): Promise<Chat | null> {
        const da = await this.authFetch(
            `/api/chat-backups/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}/${encodeURIComponent(versionId)}`
        )
        if (da.status === 404) return null
        if (da.status < 200 || da.status >= 300) throw new Error(`chat backup fetch error: ${da.status}`)
        const buffer = new Uint8Array(await da.arrayBuffer())
        return normalizeChat(await decodeRisuSave(buffer))
    }

    // ── Chat content (runtime lazy load) ────────────────────────────────────

    async fetchChatContent(chaId: string, chatIndex: number, chatId: string): Promise<any | null> {
        const url = `/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`
        if (!isResourceCacheEnabled()) {
            const da = await this.authFetch(url, {
                headers: { 'x-chat-id': chatId },
            })
            if (da.status === 404) return null
            if (da.status < 200 || da.status >= 300) throw new Error(`fetchChatContent error: ${da.status}`)
            const buffer = new Uint8Array(await da.arrayBuffer())
            return normalizeChat(await decodeRisuSave(buffer))
        }

        const resourceKey = `chat:${chaId}/${chatId}`
        let manifestHashes: string[] = []
        try {
            manifestHashes = await getManifestHashes(resourceKey)
        } catch {
            // Cache failures must not block an authoritative chat read.
        }
        const headers: Record<string, string> = { 'x-chat-id': chatId }
        if (manifestHashes.length > 0) {
            headers['x-cached-hashes'] = manifestHashes.join(',')
        }

        let da = await this.authFetch(url, { headers })
        if (da.status === 404) return null
        if (da.status === 204) {
            try {
                const contentHash = da.headers.get('x-content-hash')
                if (!isSha256Hex(contentHash) || !manifestHashes.includes(contentHash)) {
                    throw new Error('Invalid cached chat response')
                }
                const cachedBytes = await getVerifiedCachedBytes(contentHash)
                if (!cachedBytes) throw new Error('Cached chat bytes are unavailable')
                const chat = normalizeChat(await decodeRisuSave(cachedBytes))
                void touchResourceCacheManifest(resourceKey)
                return chat
            } catch {
                da = await this.authFetch(url, {
                    headers: { 'x-chat-id': chatId },
                })
                if (da.status === 404) return null
            }
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`fetchChatContent error: ${da.status}`)
        const buffer = new Uint8Array(await da.arrayBuffer())
        const chat = normalizeChat(await decodeRisuSave(buffer))
        void storeBytes(resourceKey, buffer).catch(() => {
            // IndexedDB, quota, and Web Crypto anomalies are non-authoritative.
        })
        return chat
    }

    async saveChatContent(chaId: string, chatIndex: number, chatId: string, chat: any, backupReason?: string): Promise<void> {
        const encoded = encodeRisuSaveLegacy(chat)
        const cacheEnabled = isResourceCacheEnabled()
        const requestHash = cacheEnabled
            ? sha256Bytes(encoded).catch(() => null)
            : null
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'x-chat-id': chatId,
        }
        if (backupReason !== undefined) {
            headers['x-chat-backup-reason'] = backupReason
        }
        const da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
            method: 'POST',
            headers,
            body: encoded,
        })
        if (da.status < 200 || da.status >= 300) throw new Error(`saveChatContent error: ${da.status}`)
        if (!cacheEnabled || !requestHash) return

        const response = await da.json().catch(() => null)
        const encodedHash = await requestHash
        if (!encodedHash || response?.hash !== encodedHash) return
        try {
            await storeBytes(`chat:${chaId}/${chatId}`, encoded)
        } catch {
            // The server write succeeded; cache persistence is best-effort.
        }
    }

    // ── Save-folder migration ─────────────────────────────────────────────────

    async scanSaveFolder(folderPath?: string): Promise<{count: number, totalSize: number, hasDatabase: boolean}> {
        const da = await this.authFetch('/api/migrate/save-folder/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeSaveFolderImport(folderPath?: string): Promise<{ok: boolean, imported: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `import error: ${da.status}`)
        }
        return da.json()
    }

    async uploadSaveFolderZip(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, imported: number}> {
        const authHeader = await this.createAuth()

        return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/migrate/save-folder/upload')
            xhr.setRequestHeader('content-type', 'application/zip')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }

            xhr.onerror = () => reject(new Error('zip upload failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `zip import error: ${xhr.status}`
                    try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
                    reject(new Error(msg))
                    return
                }
                try {
                    resolve(JSON.parse(xhr.responseText))
                } catch (error) {
                    reject(error)
                }
            }

            xhr.send(file)
        })
    }

    async scanCleanup(): Promise<{count: number, totalSize: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/scan', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeCleanup(): Promise<{ok: boolean, removed: number, freedBytes: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/execute', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup error: ${da.status}`)
        }
        return da.json()
    }

}

async function digestPassword(message:string, signal: AbortSignal) {
    throwIfAborted(signal)
    const res = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST",
        signal,
    })
    if(res.status < 200 || res.status >= 300){
        throw new Error(`Password hashing failed (${res.status})`)
    }
    return await awaitWithAbort(res.text(), signal)
}
