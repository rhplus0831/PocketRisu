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
    getManifestHashes,
    getVerifiedManifestSnapshot,
    getVerifiedCachedBytes,
    invalidateResourceCachePrefix,
    isResourceCacheEnabled,
    isSha256Hex,
    persistResourceCacheManifests,
    sha256Bytes,
    settleBestEffortResourceCache,
    storeBytes,
    storeOwnedBytesWithKnownHash,
    touchResourceCacheManifest,
    invalidateResourceCacheManifest,
} from "./resourceCache"
import { getThrownMessage, StorageError } from "./storageError"
import { awaitWithAbort, forwardAbortSignal, throwIfAborted } from "./abort"
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

export const AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS = 15_000
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
        sha256: string | null
        uploaded: boolean
    }[]
    uploaded: number
    total: number
    totalBytes: number
    etag?: string
}

const PLUGIN_TRANSITION_STATES = new Set(['uploading', 'ready', 'committed', 'aborted'])

function isPluginStorageStagedTransitionStatus(
    value: unknown,
    transitionId: string,
): value is PluginStorageStagedTransitionStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const result = value as Record<string, unknown>
    if (result.success !== true
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
        || result.total !== result.rows.length) return false
    let uploaded = 0
    let totalBytes = 0
    const storageKeys = new Set<string>()
    for (const rowValue of result.rows) {
        if (!rowValue || typeof rowValue !== 'object' || Array.isArray(rowValue)) return false
        const row = rowValue as Record<string, unknown>
        if (typeof row.storageKey !== 'string'
            || !Number.isSafeInteger(row.size)
            || (row.size as number) <= 0
            || (row.size as number) > 32 * 1024 * 1024
            || typeof row.uploaded !== 'boolean'
            || !(row.sha256 === null || isSha256Hex(row.sha256))) return false
        if (storageKeys.has(row.storageKey as string)
            || (row.uploaded && !isSha256Hex(row.sha256))) return false
        storageKeys.add(row.storageKey as string)
        if (row.uploaded) uploaded += 1
        totalBytes += row.size as number
        if (!Number.isSafeInteger(totalBytes)) return false
    }
    return result.uploaded === uploaded
        && result.totalBytes === totalBytes
        && (result.etag === undefined || typeof result.etag === 'string')
        && (result.state !== 'committed'
            || (typeof result.etag === 'string' && /^[0-9a-f]{32}$/.test(result.etag)))
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

const PLUGIN_STORAGE_PREFIXES = ['pluginsave/', 'pluginsave-meta/'] as const
const PLUGIN_STORAGE_MAX_RETRIES = 2
const PLUGIN_STORAGE_DEFAULT_RETRY_SECONDS = 0.25
const PLUGIN_STORAGE_MAX_RETRY_DELAY_SECONDS = 5

function isPluginStorageTarget(target: string): boolean {
    return PLUGIN_STORAGE_PREFIXES.some(prefix => target.startsWith(prefix))
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
        const commitOutcomeUnknown = mutation && payload.commitOutcomeUnknown !== false
        return new StorageError(payloadMessage(payload) ?? `${operation} failed`, {
            status,
            code: typeof payload.code === 'string'
                ? payload.code
                : (commitOutcomeUnknown ? 'COMMIT_OUTCOME_UNKNOWN' : 'STORAGE_RESPONSE_ERROR'),
            retryAfter: parseRetryAfterSeconds(payload.retryAfter),
            retryable: payload.retryable === true,
            commitOutcomeUnknown,
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
    ): Promise<PluginStorageStagedTransitionStatus> {
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
                        operation: 'transition',
                    })
                }
                if (!isPluginStorageStagedTransitionStatus(result, transitionId)) {
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
                if (typeof result.etag === 'string') this._lastDbEtag = result.etag
                return result as PluginStorageStagedTransitionStatus
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
        )
    }

    async uploadPluginStorageTransitionRow(
        transitionId: string,
        storageKey: string,
        bytes: Uint8Array,
        externalSignal?: AbortSignal | null,
    ): Promise<PluginStorageStagedTransitionStatus> {
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
                outcome.markDefinitiveResponse()
                return result as PluginStorageStagedTransitionStatus
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
            if (row?.uploaded) return status
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
        )
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
        )
    }

    async abortPluginStorageTransition(
        transitionId: string,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageStagedTransitionStatus> {
        return await this.stagedPluginStorageControl(
            '/api/plugin-storage/transition/stage/abort',
            transitionId,
            'POST',
            undefined,
            signal,
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
                expectedValueHash = await sha256Bytes(stableRequest.valueBytes!)
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
            expectedManifest: {
                ...request.expectedManifest,
                valueKeys: [...request.expectedManifest.valueKeys],
                metaKeys: [...request.expectedManifest.metaKeys],
            },
            operations: request.operations.map(operation => operation.operation === 'set'
                ? { ...operation, valueBytes: new Uint8Array(operation.valueBytes) }
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
        const requestHash = await sha256Bytes(requestBytes)
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
                for (const operation of request.operations) {
                    const valueKey = `${PLUGIN_STORAGE_PREFIXES[0]}${Buffer.from(
                        operation.key,
                        'utf-8',
                    ).toString('base64url')}.json`
                    if (operation.operation === 'set') {
                        void settleBestEffortResourceCache(
                            storeBytes(`kv:${valueKey}`, operation.valueBytes),
                            null,
                        )
                    } else {
                        void invalidateResourceCacheManifest(`kv:${valueKey}`)
                    }
                }
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
            return { missing: true, valueBytes: null, revision: null, generation: null }
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
     * Publish one internal snapshot through the same exclusive transaction as
     * the Settings restore flow. This is a mutation even though bootstrap uses
     * it while reading: an interrupted response must remain commit-unknown so
     * callers never blindly replay an older snapshot over a possibly committed
     * recovery point.
     */
    async restoreInternalSnapshotForBoot(
        key: string,
        externalSignal?: AbortSignal | null,
    ): Promise<'committed'> {
        if (!/^database\/dbbackup-\d+\.bin$/.test(key)) {
            throw new TypeError('Invalid internal snapshot key')
        }
        return runBoundedAuthoritativeStorageOperation<'committed'>(async (signal, outcome) => {
            const response = await this.requestStorage(
                key,
                'transition',
                true,
                () => this.authFetch('/api/db/snapshots/restore', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ key }),
                    signal,
                }, true, outcome),
                [],
                signal,
                outcome,
            )

            // Consume and validate the commit envelope before making the
            // acknowledgement definitive. A proxy-generated 2xx or a truncated
            // body after COMMIT cannot be mistaken for a known outcome.
            outcome.markRequestDispatched()
            let payload: StorageFailurePayload & { ok?: unknown } = {}
            try {
                const parsed = await awaitWithAbort(response.clone().json(), signal) as unknown
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    payload = parsed as StorageFailurePayload & { ok?: unknown }
                }
            } catch {
                // Invalid success acknowledgements remain commit-unknown.
            }
            if (
                payload.ok !== true
                || payload.commitOutcome !== 'committed'
                || payload.commitOutcomeUnknown !== false
            ) {
                throw new StorageError('Snapshot recovery returned an invalid commit acknowledgement', {
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
        }, 'transition', AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS, externalSignal)
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

    async exportBackup(opts?: { target?: 'upstream'; scope?: 'partial' }): Promise<Response> {
        const params = new URLSearchParams()
        if (opts?.target === 'upstream') params.set('target', 'upstream')
        if (opts?.scope === 'partial') params.set('scope', 'partial')
        const query = params.toString()
        const url = `/api/backup/export${query ? `?${query}` : ''}`
        const da = await this.authFetch(url)
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
