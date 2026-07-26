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
    storeBytes,
    touchResourceCacheManifest,
} from "./resourceCache"
import { getThrownMessage, StorageError } from "./storageError"

export type BootDatabaseReadResult =
    | { kind: 'bytes', bytes: Buffer | null }
    | { kind: 'decoded', database: Record<string, any> }

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

type StorageOperation = 'read' | 'list' | 'write' | 'remove'

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
    private static sessionPending: Promise<void> | null = null
    private refreshPending: Promise<string> | null = null

    async createAuth(){
        const now = Date.now()
        if (this.cachedJwt && this.cachedJwt.expiresAt - now > 30_000) {
            return this.cachedJwt.token
        }
        const token = await this._refreshToken()
        return token
    }

    // Called once after JWT auth is confirmed. Issues a session cookie so that
    // <img src="/api/asset/..."> can be served without JS-injected headers.
    private async initSession() {
        if (NodeStorage.sessionInitialized) return
        if (NodeStorage.sessionPending) return NodeStorage.sessionPending
        NodeStorage.sessionPending = this._doInitSession()
        return NodeStorage.sessionPending
    }

    private async _doInitSession() {
        try {
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: {
                    'risu-auth': await this.createAuth(),
                    'x-session-id': NodeStorage.sessionId,
                },
            })
            if (res.ok) {
                NodeStorage.sessionInitialized = true
            }
            // Non-ok (400/401/500): will retry on next checkAuth() call.
        } catch {
            // Network error: will retry on next checkAuth() call.
        } finally {
            NodeStorage.sessionPending = null
        }
    }

    private async _refreshToken(): Promise<string> {
        if (this.refreshPending) return this.refreshPending
        this.refreshPending = this._doRefreshToken()
        try { return await this.refreshPending }
        finally { this.refreshPending = null }
    }

    private async _doRefreshToken(): Promise<string> {
        const res = await fetch('/api/token/refresh', {
            method: 'POST',
            headers: { 'risu-auth': this.cachedJwt?.token ?? '' }
        })
        if (res.ok) {
            const data = await res.json()
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
            return data.token
        }
        return this.cachedJwt?.token ?? ''
    }

    private async loginWithPassword(password: string) {
        const response = await fetch('/api/login', {
            method: "POST",
            body: JSON.stringify({ password }),
            headers: {
                'content-type': 'application/json'
            }
        })

        if(response.status === 429){
            notifyError(`Too many attempts. Please wait and try again later.`)
            await waitAlert()
            throw new Error('Too many login attempts')
        }

        if(response.status < 200 || response.status >= 300){
            let message = 'Node login failed'
            try {
                const data = await response.json()
                message = data.error ?? message
            } catch {
                // noop
            }
            throw new Error(message)
        }

        const data = await response.json()
        if (data.token) {
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response) {
        if(response.status !== 400 && response.status !== 401){
            return false
        }

        try {
            const data = await response.clone().json()
            return [
                'No auth header',
                'Invalid Signature',
                'Token Expired'
            ].includes(data?.error)
        } catch {
            return false
        }
    }

    private async authFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true) {
        await this.checkAuth()
        const headers = new Headers(init.headers)
        headers.set('risu-auth', await this.createAuth())
        headers.set('x-session-id', NodeStorage.sessionId)

        const response = await fetch(input, {
            ...init,
            headers
        })

        if (response.status === 423) {
            window.dispatchEvent(new CustomEvent('risu-session-deactivated'))
        }

        if(retry && await this.shouldRetryAuth(response)){
            this.authChecked = false
            this.cachedJwt = null
            await this.checkAuth()
            return this.authFetch(input, init, false)
        }

        return response
    }

    private async parseStorageFailureResponse(
        response: Response,
        operation: StorageOperation,
        mutation: boolean,
    ): Promise<StorageError> {
        let payload: StorageFailurePayload | null = null
        let responseText = ''
        try {
            const parsed = await response.clone().json() as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = parsed as StorageFailurePayload
            } else if (typeof parsed === 'string') {
                responseText = parsed
            }
        } catch {
            try {
                responseText = await response.clone().text()
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

    private async waitForPluginStorageRetry(error: StorageError, retryIndex: number): Promise<void> {
        const delaySeconds = Math.min(
            error.retryAfter
                ?? PLUGIN_STORAGE_DEFAULT_RETRY_SECONDS * (2 ** retryIndex),
            PLUGIN_STORAGE_MAX_RETRY_DELAY_SECONDS,
        )
        if (delaySeconds <= 0) return
        await new Promise<void>(resolve => setTimeout(resolve, delaySeconds * 1000))
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
    ): Promise<Response> {
        const retryPluginOperation = isPluginStorageTarget(target)
        for (let retryIndex = 0; ; retryIndex++) {
            let response: Response
            try {
                response = await request()
            } catch (error) {
                const storageError = this.makeStorageTransportError(error, operation, mutation)
                if (retryPluginOperation
                    && storageError.retryable
                    && !storageError.commitOutcomeUnknown
                    && retryIndex < PLUGIN_STORAGE_MAX_RETRIES) {
                    await this.waitForPluginStorageRetry(storageError, retryIndex)
                    continue
                }
                throw storageError
            }

            if (response.ok || allowedStatuses.includes(response.status)) return response
            const storageError = await this.parseStorageFailureResponse(response, operation, mutation)
            if (retryPluginOperation
                && storageError.retryable
                && !storageError.commitOutcomeUnknown
                && retryIndex < PLUGIN_STORAGE_MAX_RETRIES) {
                await this.waitForPluginStorageRetry(storageError, retryIndex)
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
    ): Promise<{ message: string; currentEtag: string } | null> {
        if (response.status !== 409
            || key !== 'database/database.bin'
            || typeof requestedEtag !== 'string'
            || requestedEtag.length === 0) {
            return null
        }
        try {
            const payload = await response.clone().json() as unknown
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

    async setItem(key:string, value:Uint8Array, etag?:string) {
        const shouldSeedResourceCache = isResourceCacheEnabled() && key.startsWith('pluginsave/')
        const requestBytes = shouldSeedResourceCache ? new Uint8Array(value) : value
        const requestHash = shouldSeedResourceCache
            ? sha256Bytes(requestBytes).catch(() => null)
            : null
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await this.requestStorage(key, 'write', true, () => this.authFetch('/api/write', {
            method: "POST",
            body: requestBytes as any,
            headers
        }), [409])
        if(da.status === 409){
            const conflict = await this.parseDatabaseConflict(da, key, etag)
            if (conflict) {
                throw new ConflictError(conflict.message, conflict.currentEtag)
            }
            throw await this.parseStorageFailureResponse(da, 'write', true)
        }
        const data = await da.json()
        if(data.error){
            throw this.storagePayloadError(data, 'write', true, da.status)
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        if (requestHash && isSha256Hex(data.hash)) {
            const encodedHash = await requestHash
            if (encodedHash === data.hash) {
                try {
                    await storeBytes(`kv:${key}`, requestBytes)
                } catch {
                    // The authoritative write succeeded; cache seeding is best-effort.
                }
            }
        }
    }
    async getItem(key:string):Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }

        const da = await this.requestStorage(key, 'read', false, () => (
            this.authFetch('/api/read', { method: "GET", headers })
        ))

        // Capture ETag for database.bin
        const etag = da.headers.get('x-db-etag')
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length === 0){
            return null
        }

        return data
    }

    async getItemCached(key: string): Promise<Buffer | null> {
        if (!isResourceCacheEnabled() || key === 'database/database.bin') {
            return await this.getItem(key)
        }

        const resourceKey = `kv:${key}`
        let manifestHashes: string[] = []
        try {
            manifestHashes = (await getVerifiedManifestSnapshot(resourceKey))?.hashes ?? []
        } catch {
            // Cache failures degrade to the ordinary read below.
        }

        const plainHeaders: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex'),
        }
        const headers: Record<string, string> = { ...plainHeaders }
        if (manifestHashes.length > 0) {
            headers['x-cached-hashes'] = manifestHashes.join(',')
        }

        let response = await this.requestStorage(key, 'read', false, () => (
            this.authFetch('/api/read', { method: 'GET', headers })
        ))
        if (response.status === 204) {
            try {
                const contentHash = response.headers.get('x-content-hash')
                if (!isSha256Hex(contentHash) || !manifestHashes.includes(contentHash)) {
                    throw new Error('Invalid cached KV response')
                }
                const cachedBytes = await getVerifiedCachedBytes(contentHash)
                if (!cachedBytes) throw new Error('Cached KV bytes are unavailable')
                void touchResourceCacheManifest(resourceKey)
                return cachedBytes.byteLength === 0 ? null : Buffer.from(cachedBytes)
            } catch {
                response = await this.requestStorage(key, 'read', false, () => (
                    this.authFetch('/api/read', { method: 'GET', headers: plainHeaders })
                ))
            }
        }

        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0) return null
        void storeBytes(resourceKey, bytes).catch(() => {
            // IndexedDB, quota, and Web Crypto anomalies are non-authoritative.
        })
        return bytes
    }

    async readDatabaseForBoot(): Promise<BootDatabaseReadResult> {
        if (!isResourceCacheEnabled()) {
            return { kind: 'bytes', bytes: await this.getItem('database/database.bin') }
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
            // The universal full read is authoritative and never seeds segments.
            return { kind: 'bytes', bytes: await this.getItem('database/database.bin') }
        }
    }
    async keys(prefix: string = ''):Promise<string[]>{
        const headers: Record<string, string> = {}
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        const cached = await listCacheGet(prefix)
        if (cached) {
            headers['x-last-sync'] = String(cached.timestamp)
            headers['x-list-epoch'] = cached.epoch
        }
        const da = await this.requestStorage(prefix, 'list', false, () => this.authFetch('/api/list', {
            method: "GET",
            headers
        }))
        const data = await da.json()
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
    async removeItem(key:string){
        const da = await this.requestStorage(key, 'remove', true, () => this.authFetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        }))
        const data = await da.json()
        if(data.error){
            throw this.storagePayloadError(data, 'remove', true, da.status)
        }
    }

    /** Atomically clear the complete optimized save value + owner namespace. */
    async clearPluginSaveStorage(): Promise<'committed'> {
        const response = await this.requestStorage(
            PLUGIN_STORAGE_PREFIXES[0],
            'remove',
            true,
            () => this.authFetch('/api/plugin-storage/clear', { method: 'POST' }),
        )

        let payload: StorageFailurePayload & { success?: unknown } = {}
        try {
            const parsed = await response.clone().json() as unknown
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

        // A committed whole-namespace clear invalidates both cached key lists
        // and any hash-addressed plugin manifests. Cache cleanup is
        // best-effort and never changes the authoritative acknowledgement.
        void listCacheDelete(['', ...PLUGIN_STORAGE_PREFIXES])
        void invalidateResourceCachePrefix(`kv:${PLUGIN_STORAGE_PREFIXES[0]}`)
        void invalidateResourceCachePrefix(`kv:${PLUGIN_STORAGE_PREFIXES[1]}`)
        return 'committed'
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': this.cachedJwt?.token ?? ''
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })

                if(response.status < 200 || response.status >= 300){
                    throw new Error('Failed to set node password')
                }

                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else if(data.status === 'incorrect'){
                const input = await digestPassword(await alertInput(language.inputNodePassword))
                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else{
                if (data.token) {
                    this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
                }
                this.authChecked = true
            }
        }
        await this.initSession()
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

    async exportBackup(opts?: { target?: 'upstream' }): Promise<Response> {
        const url = opts?.target === 'upstream'
            ? '/api/backup/export?target=upstream'
            : '/api/backup/export'
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

async function digestPassword(message:string) {
    const res = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })
    if(res.status < 200 || res.status >= 300){
        throw new Error(`Password hashing failed (${res.status})`)
    }
    return await res.text()
}
