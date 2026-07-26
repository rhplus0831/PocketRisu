import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import utilsPkg from '../../../server/node/utils.cjs'

const cache = vi.hoisted(() => ({ enabled: false }))

vi.mock('./resourceCache', () => ({
    applyOwnedResourceCacheMutations: vi.fn(async () => undefined),
    getManifestHashes: vi.fn(async () => []),
    getVerifiedManifestSnapshot: vi.fn(async () => null),
    getVerifiedCachedBytes: vi.fn(async () => null),
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    isResourceCacheEnabled: () => cache.enabled,
    isSha256Hex: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: vi.fn(async () => 'a'.repeat(64)),
    sha256OwnedBytes: vi.fn(async () => 'a'.repeat(64)),
    settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
        try { return await operation } catch { return fallback }
    },
    storeBytes: vi.fn(async () => undefined),
    storeOwnedBytesWithKnownHash: vi.fn(async () => undefined),
    touchResourceCacheManifest: vi.fn(async () => undefined),
}))

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    notifyError: vi.fn(),
    waitAlert: vi.fn(),
}))

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('./database.svelte', () => ({ normalizeChat: (chat: unknown) => chat }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

const { INTERNAL_SNAPSHOT_RESTORE_TIMEOUT_MS, NodeStorage } = await import('./nodeStorage')
const { StorageError } = await import('./storageError')
const { recoverDatabaseFromInternalSnapshots } = await import('./bootSnapshotRecovery')
const { runInternalSnapshotRestoreUi } = await import('./snapshotRestoreUi')
const resourceCache = await import('./resourceCache')

const {
    decodeRisuSave: decodeServerRisuSave,
    encodeRisuSaveLegacy: encodeServerRisuSaveLegacy,
} = utilsPkg as {
    decodeRisuSave: (value: Buffer) => Promise<any>
    encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}
const serverEntry = path.resolve(process.cwd(), 'server/node/server.cjs')
const testPassword = crypto.createHash('sha256').update('boot-snapshot-client-test').digest('hex')

interface RunningServer {
    child: ChildProcessWithoutNullStreams
    origin: string
    logs: () => string
}

async function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input))
    const body = init.body == null
        ? null
        : typeof init.body === 'string'
            ? Buffer.from(init.body)
            : Buffer.from(init.body as unknown as Uint8Array)
    const headers = new Headers(init.headers)
    if (body && !headers.has('content-length')) headers.set('content-length', String(body.length))
    return await new Promise<Response>((resolve, reject) => {
        const request = http.request(url, {
            method: init.method ?? 'GET',
            headers: Object.fromEntries(headers.entries()),
        }, response => {
            const chunks: Buffer[] = []
            response.on('data', chunk => chunks.push(Buffer.from(chunk)))
            response.once('end', () => resolve(new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage,
                headers: response.headers as Record<string, string>,
            })))
            response.once('error', reject)
        })
        request.once('error', reject)
        const abort = () => request.destroy(new DOMException('Aborted', 'AbortError'))
        if (init.signal?.aborted) abort()
        else init.signal?.addEventListener('abort', abort, { once: true })
        request.once('close', () => init.signal?.removeEventListener('abort', abort))
        if (body) request.end(body)
        else request.end()
    })
}

async function freePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('Could not allocate a test port'))
                return
            }
            server.close(error => error ? reject(error) : resolve(address.port))
        })
    })
}

async function startRealServer(cwd: string): Promise<RunningServer> {
    const port = await freePort()
    let output = ''
    const child = spawn(process.execPath, [serverEntry], {
        cwd,
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            RISU_UPDATE_CHECK: 'false',
            POCKETRISU_BACKUP_INTERVAL_MS: '3600000',
            POCKETRISU_CHUNK_THRESHOLD: '4096',
            RISU_STREAM_INGEST_MIN_BYTES: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const running = {
        child,
        origin: `http://127.0.0.1:${port}`,
        logs: () => output,
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Server exited during startup:\n${output}`)
        }
        try {
            const response = await nodeFetch(`${running.origin}/api/test_auth`, {
                headers: { 'risu-auth': 'not-a-token' },
                signal: AbortSignal.timeout(500),
            })
            if (response.ok) return running
        } catch {
            // Socket not ready yet.
        }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    child.kill('SIGKILL')
    throw new Error(`Server did not start:\n${output}`)
}

async function stopRealServer(server: RunningServer): Promise<void> {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return
    const exited = new Promise<void>(resolve => server.child.once('exit', () => resolve()))
    server.child.kill('SIGTERM')
    if (!await Promise.race([
        exited.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
    ])) {
        server.child.kill('SIGKILL')
        await exited
    }
}

async function login(server: RunningServer): Promise<string> {
    const response = await nodeFetch(`${server.origin}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: testPassword }),
    })
    if (!response.ok) throw new Error(`Login failed: ${await response.text()}`)
    return (await response.json() as { token: string }).token
}

async function writeRealKey(
    server: RunningServer,
    token: string,
    key: string,
    value: Uint8Array,
): Promise<void> {
    const response = await nodeFetch(`${server.origin}/api/write`, {
        method: 'POST',
        headers: {
            'risu-auth': token,
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key).toString('hex'),
        },
        body: value as unknown as BodyInit,
    })
    if (!response.ok) throw new Error(`Write failed (${response.status}): ${await response.text()}`)
}

function readyStorage(): InstanceType<typeof NodeStorage> {
    const storage = new NodeStorage()
    storage.authChecked = true
    ;(NodeStorage as any).sessionInitialized = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('test-token')
    return storage
}

beforeEach(() => {
    vi.clearAllMocks()
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
    cache.enabled = false
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('NodeStorage boot snapshot recovery', () => {
    it('lists only strict metadata in authoritative newest-first order', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe('/api/db/snapshots')
            return new Response(JSON.stringify({
                snapshots: [
                    { key: 'database/dbbackup-200.bin', size: 8192, timestamp: 20_000 },
                    { key: 'database/dbbackup-100.bin', size: 4096, timestamp: 10_000 },
                ],
            }), { status: 200, headers: { 'content-type': 'application/json' } })
        })
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().listInternalSnapshotsForBoot()).resolves.toEqual([
            { key: 'database/dbbackup-200.bin', size: 8192, timestamp: 20_000 },
            { key: 'database/dbbackup-100.bin', size: 4096, timestamp: 10_000 },
        ])
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it.each([
        {
            snapshots: [{ key: 'database/dbbackup-200.bin/extra', size: 1, timestamp: 20_000 }],
            label: 'prefix sibling key',
        },
        {
            snapshots: [{ key: 'database/dbbackup-0200.bin', size: 1, timestamp: 20_000 }],
            label: 'noncanonical leading zero',
        },
        {
            snapshots: [{
                key: 'database/dbbackup-90071992547410.bin',
                size: 1,
                timestamp: 9_007_199_254_741_000,
            }],
            label: 'unsafe timestamp product',
        },
        {
            snapshots: [
                { key: 'database/dbbackup-100.bin', size: 1, timestamp: 10_000 },
                { key: 'database/dbbackup-200.bin', size: 1, timestamp: 20_000 },
            ],
            label: 'oldest-first order',
        },
        {
            snapshots: [{ key: 'database/dbbackup-200.bin', size: 1, timestamp: 20_001 }],
            label: 'key/timestamp mismatch',
        },
        {
            snapshots: [{ key: 'database/dbbackup-200.bin', size: 1, timestamp: 20_000, extra: true }],
            label: 'schema extension',
        },
    ])('rejects a malformed snapshot list: $label', async ({ snapshots }) => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ snapshots }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))

        await expect(readyStorage().listInternalSnapshotsForBoot()).rejects.toMatchObject({
            code: 'STORAGE_RESPONSE_ERROR',
            operation: 'list',
        } satisfies Partial<InstanceType<typeof StorageError>>)
    })

    it('reads corrupt live bytes without asking the server to decode them', async () => {
        const corrupt = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe('/api/db/read-raw-for-boot')
            return new Response(corrupt, {
                status: 200,
                headers: { 'x-db-etag': 'b'.repeat(32) },
            })
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const result = await storage.readDatabaseForBoot()

        expect(result).toEqual({ kind: 'bytes', bytes: Buffer.from(corrupt) })
        expect(storage._lastDbEtag).toBe('b'.repeat(32))
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('accepts only the complete committed restore acknowledgement', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe('/api/db/snapshots/restore')
            expect(init).toMatchObject({
                method: 'POST',
                body: JSON.stringify({ key: 'database/dbbackup-123.bin' }),
            })
            return new Response(JSON.stringify({
                ok: true,
                key: 'database/dbbackup-123.bin',
                commitOutcome: 'committed',
                commitOutcomeUnknown: false,
            }), { status: 200, headers: { 'content-type': 'application/json' } })
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()
        storage._lastDbEtag = 'stale-etag'

        await expect(storage.restoreInternalSnapshot(
            'database/dbbackup-123.bin',
        )).resolves.toBe('committed')

        expect(storage._lastDbEtag).toBeNull()
        expect(resourceCache.invalidateResourceCacheManifest).toHaveBeenCalledTimes(5)
    })

    it('keeps a truncated success acknowledgement commit-unknown', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"key":', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))

        await expect(readyStorage().restoreInternalSnapshot(
            'database/dbbackup-456.bin',
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'transition',
        } satisfies Partial<InstanceType<typeof StorageError>>)
    })

    it.each([
        {
            label: 'extra field',
            status: 200,
            body: {
                ok: true,
                commitOutcome: 'committed',
                commitOutcomeUnknown: false,
                extra: true,
            },
        },
        {
            label: 'non-200 success status',
            status: 201,
            body: {
                ok: true,
                commitOutcome: 'committed',
                commitOutcomeUnknown: false,
            },
        },
    ])('keeps a $label acknowledgement commit-unknown', async ({ status, body }) => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
        })))

        await expect(readyStorage().restoreInternalSnapshot(
            'database/dbbackup-456.bin',
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'transition',
        } satisfies Partial<InstanceType<typeof StorageError>>)
    })

    it('keeps a transport loss after restore dispatch commit-unknown', async () => {
        const fetchMock = vi.fn(async () => {
            throw new TypeError('socket closed before acknowledgement')
        })
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshot(
            'database/dbbackup-789.bin',
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            retryable: false,
            operation: 'transition',
        } satisfies Partial<InstanceType<typeof StorageError>>)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('accepts the exact rollback envelope as definitive and never retries it', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            error: 'Snapshot restore was not committed',
            code: 'SNAPSHOT_RESTORE_NOT_COMMITTED',
            retryAfter: 0,
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        }), { status: 500, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshot(
            'database/dbbackup-444.bin',
        )).rejects.toMatchObject({
            status: 500,
            code: 'SNAPSHOT_RESTORE_NOT_COMMITTED',
            commitOutcomeUnknown: false,
            retryable: true,
        } satisfies Partial<InstanceType<typeof StorageError>>)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it.each([
        'database/dbbackup-123.bin/../../database.bin',
        'database/dbbackup-0123.bin',
        'database/dbbackup-90071992547410.bin',
    ])('rejects malformed snapshot name %s before dispatch', async (key) => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshot(
            key,
        )).rejects.toThrow('Invalid internal snapshot key')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('restores an older valid 64 MiB chunked candidate without reading candidate bodies', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-boot-snapshot-client-'))
        const saveDir = path.join(cwd, 'save')
        fs.mkdirSync(saveDir)
        fs.writeFileSync(path.join(saveDir, '__password'), testPassword)
        let server: RunningServer | null = null
        try {
            server = await startRealServer(cwd)
            const token = await login(server)
            const olderKey = 'database/dbbackup-70000000000000.bin'
            const newerKey = 'database/dbbackup-70000000000001.bin'
            const messageBody = 'v'.repeat(64 * 1024 * 1024)
            const messageHash = crypto.createHash('sha256').update(messageBody).digest('hex')
            const validCandidate = encodeServerRisuSaveLegacy({
                characters: [{
                    chaId: 'boot-large-character',
                    name: 'Boot recovery',
                    chats: [{
                        id: 'boot-large-chat',
                        name: 'Recovered',
                        message: [{ role: 'char', data: messageBody }],
                    }],
                }],
                bootSnapshotRevision: 'older-valid',
            })
            expect(validCandidate.byteLength).toBeGreaterThanOrEqual(64 * 1024 * 1024)
            await writeRealKey(server, token, olderKey, validCandidate)
            await writeRealKey(server, token, newerKey, new Uint8Array(
                Buffer.alloc(64 * 1024 * 1024, 0x5a),
            ))
            await stopRealServer(server)
            server = null

            const sqlitePath = path.join(saveDir, 'risuai.db')
            const seeded = new Database(sqlitePath)
            const chunkCounts = seeded.prepare(
                'SELECT manifest_key AS key, COUNT(*) AS count FROM manifest_chunks '
                + 'WHERE manifest_key IN (?, ?) GROUP BY manifest_key ORDER BY manifest_key',
            ).all(olderKey, newerKey) as Array<{ key: string; count: number }>
            expect(chunkCounts).toHaveLength(2)
            expect(chunkCounts.every(row => row.count > 100)).toBe(true)
            seeded.transaction(() => {
                seeded.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?')
                    .run('database/database.bin')
                seeded.prepare(
                    'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
                ).run('database/database.bin', Buffer.from('corrupt-live'), Date.now())
            })()
            seeded.close()

            server = await startRealServer(cwd)
            expect(server.logs()).toContain('starting in snapshot-recovery mode')
            const recoveryToken = await login(server)
            const requests: string[] = []
            const fetchRecorder = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const requestPath = String(input)
                requests.push(requestPath)
                if (requestPath === '/api/read') {
                    throw new Error('Boot recovery must never use candidate /api/read')
                }
                const url = requestPath.startsWith('/')
                    ? `${server!.origin}${requestPath}`
                    : requestPath
                return await nodeFetch(url, init)
            })
            vi.stubGlobal('fetch', fetchRecorder)
            const storage = readyStorage()
            vi.mocked(storage.createAuth).mockResolvedValue(recoveryToken)
            const decode = vi.fn(async (bytes: Uint8Array) => (
                await decodeServerRisuSave(Buffer.from(bytes))
            ))

            const restored = await recoverDatabaseFromInternalSnapshots({ storage, decode })

            expect(restored).toMatchObject({ bootSnapshotRevision: 'older-valid' })
            expect(requests.filter(pathname => pathname === '/api/db/snapshots')).toHaveLength(1)
            expect(requests.filter(pathname => pathname === '/api/db/snapshots/restore')).toHaveLength(2)
            expect(requests.filter(pathname => pathname === '/api/db/read-raw-for-boot')).toHaveLength(1)
            expect(requests).not.toContain('/api/read')
            expect(decode).toHaveBeenCalledOnce()
            expect(fs.readdirSync(path.join(saveDir, '.spool')).filter(
                name => name.includes('snapshot-restore'),
            )).toEqual([])

            vi.unstubAllGlobals()
            await stopRealServer(server)
            server = null
            server = await startRealServer(cwd)
            const restartToken = await login(server)
            const restartedLive = await nodeFetch(`${server.origin}/api/db/read-raw-for-boot`, {
                headers: { 'risu-auth': restartToken },
            })
            expect(restartedLive.status).toBe(200)
            expect(await decodeServerRisuSave(Buffer.from(await restartedLive.arrayBuffer())))
                .toMatchObject({ bootSnapshotRevision: 'older-valid' })
            const chatResponse = await nodeFetch(
                `${server.origin}/api/chat-content/boot-large-character/0`,
                {
                    headers: {
                        'risu-auth': restartToken,
                        'x-chat-id': 'boot-large-chat',
                    },
                },
            )
            expect(chatResponse.status).toBe(200)
            const chat = await decodeServerRisuSave(Buffer.from(await chatResponse.arrayBuffer()))
            expect(crypto.createHash('sha256').update(chat.message[0].data).digest('hex'))
                .toBe(messageHash)
            expect(fs.readdirSync(path.join(saveDir, '.spool')).filter(
                name => name.includes('snapshot-restore'),
            )).toEqual([])
        } finally {
            vi.unstubAllGlobals()
            if (server) await stopRealServer(server)
            fs.rmSync(cwd, { recursive: true, force: true })
        }
    }, 120_000)

    it('allows a valid large restore to outlive the ordinary 15 second I/O bound', async () => {
        vi.useFakeTimers()
        try {
            const fetchMock = vi.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 15_001))
                return new Response(JSON.stringify({
                    ok: true,
                    key: 'database/dbbackup-321.bin',
                    commitOutcome: 'committed',
                    commitOutcomeUnknown: false,
                }), { status: 200, headers: { 'content-type': 'application/json' } })
            })
            vi.stubGlobal('fetch', fetchMock)

            const restore = readyStorage().restoreInternalSnapshot('database/dbbackup-321.bin')
            await vi.advanceTimersByTimeAsync(15_001)

            await expect(restore).resolves.toBe('committed')
            expect(INTERNAL_SNAPSHOT_RESTORE_TIMEOUT_MS).toBeGreaterThan(15_001)
            expect(fetchMock).toHaveBeenCalledOnce()
        } finally {
            vi.useRealTimers()
        }
    })

    it('aborts a stalled restore at the finite restore-specific bound without replaying it', async () => {
        vi.useFakeTimers()
        try {
            let dispatchedSignal: AbortSignal | undefined
            const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                dispatchedSignal = init?.signal ?? undefined
                return await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        reject(new DOMException('aborted', 'AbortError'))
                    }, { once: true })
                })
            })
            vi.stubGlobal('fetch', fetchMock)

            const restore = readyStorage().restoreInternalSnapshot('database/dbbackup-333.bin')
            const assertion = expect(restore).rejects.toMatchObject({
                code: 'COMMIT_OUTCOME_UNKNOWN',
                commitOutcomeUnknown: true,
                retryable: false,
            } satisfies Partial<InstanceType<typeof StorageError>>)
            await vi.advanceTimersByTimeAsync(INTERNAL_SNAPSHOT_RESTORE_TIMEOUT_MS)

            await assertion
            expect(dispatchedSignal?.aborted).toBe(true)
            expect(fetchMock).toHaveBeenCalledOnce()
        } finally {
            vi.useRealTimers()
        }
    })

    it('rejects a proxy-generated malformed 2xx and does not retry the restore POST', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            ok: true,
            key: 'database/dbbackup-654.bin',
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
            proxy: true,
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshot(
            'database/dbbackup-654.bin',
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            retryable: false,
        } satisfies Partial<InstanceType<typeof StorageError>>)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('treats a displaced writer session as definitively not committed', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(new Headers(init?.headers).get('x-session-id')).toBeTruthy()
            return new Response(JSON.stringify({ error: 'Session deactivated' }), {
                status: 423,
                headers: { 'content-type': 'application/json' },
            })
        })
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshot(
            'database/dbbackup-987.bin',
        )).rejects.toMatchObject({
            status: 423,
            commitOutcomeUnknown: false,
            retryable: false,
        } satisfies Partial<InstanceType<typeof StorageError>>)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('keeps a stalled 423 body definitive through external abort and never reloads the UI', async () => {
        let resolveHeaders!: () => void
        const headersReturned = new Promise<void>(resolve => { resolveHeaders = resolve })
        let bodyCancelled = false
        const fetchMock = vi.fn(async () => {
            const body = new ReadableStream<Uint8Array>({
                cancel() { bodyCancelled = true },
            })
            resolveHeaders()
            return new Response(body, {
                status: 423,
                headers: { 'content-type': 'application/json' },
            })
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()
        const external = new AbortController()
        const onDefinitiveFailure = vi.fn()
        const onCommitUnknown = vi.fn()
        const hardReload = vi.fn()

        const result = runInternalSnapshotRestoreUi('database/dbbackup-555.bin', {
            restore: (key, signal) => storage.restoreInternalSnapshot(key, signal),
            onCommitted: vi.fn(),
            onDefinitiveFailure,
            onCommitUnknown,
            hardReload,
        }, external.signal)
        await headersReturned
        external.abort()

        await expect(result).resolves.toBe('not-committed')
        expect(onDefinitiveFailure).toHaveBeenCalledWith(expect.objectContaining({
            status: 423,
            commitOutcomeUnknown: false,
        }))
        expect(onCommitUnknown).not.toHaveBeenCalled()
        expect(hardReload).not.toHaveBeenCalled()
        expect(bodyCancelled).toBe(true)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('keeps a stalled 423 body definitive when the restore timeout advances', async () => {
        vi.useFakeTimers()
        try {
            let resolveHeaders!: () => void
            const headersReturned = new Promise<void>(resolve => { resolveHeaders = resolve })
            let bodyCancelled = false
            const fetchMock = vi.fn(async () => {
                const body = new ReadableStream<Uint8Array>({
                    cancel() { bodyCancelled = true },
                })
                resolveHeaders()
                return new Response(body, { status: 423 })
            })
            vi.stubGlobal('fetch', fetchMock)

            const restore = readyStorage().restoreInternalSnapshot('database/dbbackup-556.bin')
            const assertion = expect(restore).rejects.toMatchObject({
                status: 423,
                code: 'HTTP_423',
                commitOutcomeUnknown: false,
                retryable: false,
            } satisfies Partial<InstanceType<typeof StorageError>>)
            await headersReturned
            await vi.advanceTimersByTimeAsync(INTERNAL_SNAPSHOT_RESTORE_TIMEOUT_MS)

            await assertion
            expect(bodyCancelled).toBe(true)
            expect(fetchMock).toHaveBeenCalledOnce()
        } finally {
            vi.useRealTimers()
        }
    })

    it('requires the server to echo the exact requested snapshot key', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            ok: true,
            key: 'database/dbbackup-111.bin',
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshot(
            'database/dbbackup-222.bin',
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
        } satisfies Partial<InstanceType<typeof StorageError>>)
        expect(fetchMock).toHaveBeenCalledOnce()
    })
})
