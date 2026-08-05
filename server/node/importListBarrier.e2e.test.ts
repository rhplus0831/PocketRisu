import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type ClientRequest, type IncomingMessage } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { zipSync } from 'fflate'
import spoolOwnershipPkg from './spoolOwnership.cjs'

const serverEntry = path.resolve(process.cwd(), 'server/node/server.cjs')
const testPasswordDigest = crypto.createHash('sha256').update('list-delta-test').digest('hex')
const { resolveOwnedSpoolDirFromSave } = spoolOwnershipPkg as {
    resolveOwnedSpoolDirFromSave: (savePath: string, spoolRoot?: string) => string
}

interface RunningServer {
    child: ChildProcessWithoutNullStreams
    origin: string
    cwd: string
    logs: () => string
}

interface AuthHeaders {
    'risu-auth': string
    'x-session-id': string
}

interface ListResponse {
    mode: 'full' | 'delta'
    content?: string[]
    added?: string[]
    deleted?: string[]
    timestamp: number
    epoch: string
}

interface PausedImport {
    request: ClientRequest
    response: IncomingMessage
    abort: () => void
    finish: () => Promise<{ status: number; body: string }>
}

const runningServers = new Set<RunningServer>()
const tempDirs: string[] = []
const rawSaveHeader = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function getFreePort(): Promise<number> {
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
            server.close((error) => error ? reject(error) : resolve(address.port))
        })
    })
}

async function stopServer(server: RunningServer, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => server.child.once('exit', () => resolve()))
    server.child.kill(signal)
    const stopped = await Promise.race([
        exited.then(() => true),
        delay(5_000).then(() => false),
    ])
    if (!stopped && server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill('SIGKILL')
        await withTimeout(exited, 5_000, 'server process exit')
    }
}

async function waitForServer(server: RunningServer): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
        if (server.child.exitCode !== null || server.child.signalCode !== null) {
            throw new Error(`Server exited during startup:\n${server.logs()}`)
        }
        try {
            const response = await fetch(`${server.origin}/api/test_auth`, {
                headers: { 'risu-auth': 'not-a-token' },
                signal: AbortSignal.timeout(500),
            })
            if (response.ok) return
        } catch {
            // The listening socket may not be ready yet.
        }
        await delay(50)
    }
    throw new Error(`Server did not become ready:\n${server.logs()}`)
}

async function startServer(cwd: string, extraEnv: Record<string, string> = {}): Promise<RunningServer> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const port = await getFreePort()
        let output = ''
        const child = spawn(process.execPath, [serverEntry], {
            cwd,
            env: {
                ...process.env,
                HOST: '127.0.0.1',
                PORT: String(port),
                NODE_ENV: 'test',
                POCKETRISU_BACKUP_IMPORT_TEST_GATE_DIR: path.join(cwd, 'import-gate'),
                RISU_UPDATE_CHECK: 'false',
                ...extraEnv,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        child.stdout.on('data', (chunk) => { output += chunk.toString() })
        child.stderr.on('data', (chunk) => { output += chunk.toString() })
        const server = {
            child,
            origin: `http://127.0.0.1:${port}`,
            cwd,
            logs: () => output,
        }
        runningServers.add(server)
        try {
            await waitForServer(server)
            return server
        } catch (error) {
            await stopServer(server)
            runningServers.delete(server)
            if (!output.includes('EADDRINUSE') || attempt === 2) throw error
        }
    }
    throw new Error('Could not start test server')
}

function makeWorkDir(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-import-list-'))
    tempDirs.push(cwd)
    const saveDir = path.join(cwd, 'save')
    fs.mkdirSync(saveDir)
    fs.writeFileSync(path.join(saveDir, '__password'), testPasswordDigest)
    return cwd
}

async function authenticate(server: RunningServer): Promise<AuthHeaders> {
    const login = await fetch(`${server.origin}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: testPasswordDigest }),
    })
    if (!login.ok) throw new Error(`Login failed (${login.status}): ${await login.text()}`)
    const { token } = await login.json() as { token: string }
    const headers: AuthHeaders = {
        'risu-auth': token,
        'x-session-id': crypto.randomUUID(),
    }
    const session = await fetch(`${server.origin}/api/session`, {
        method: 'POST',
        headers,
    })
    if (!session.ok) throw new Error(`Session registration failed (${session.status})`)
    return headers
}

async function seedKey(
    server: RunningServer,
    auth: AuthHeaders,
    key: string,
    value = Buffer.from(JSON.stringify('durable seed')),
): Promise<void> {
    const pluginValue = key.startsWith('pluginsave/')
        && !key.startsWith('pluginsave-meta/')
    const response = await fetch(`${server.origin}${pluginValue
        ? '/api/plugin-storage/mutate'
        : '/api/write'}`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key).toString('hex'),
            ...(pluginValue ? {
                'x-plugin-storage-operation': 'set',
                'x-plugin-storage-owner': '',
            } : {}),
        },
        body: value,
    })
    if (!response.ok) throw new Error(`Seed write failed (${response.status}): ${await response.text()}`)
}

async function readKey(server: RunningServer, auth: AuthHeaders, key: string): Promise<Buffer | null> {
    const response = await fetch(`${server.origin}/api/read`, {
        headers: {
            ...auth,
            'file-path': Buffer.from(key).toString('hex'),
        },
    })
    if (!response.ok) throw new Error(`Read failed (${response.status}): ${await response.text()}`)
    const value = Buffer.from(await response.arrayBuffer())
    return value.length === 0 ? null : value
}

async function mutateKeyDuringImport(
    server: RunningServer,
    auth: AuthHeaders,
    method: 'write' | 'remove',
    key: string,
    value = Buffer.from('racing mutation'),
): Promise<Response> {
    return await fetch(`${server.origin}/api/${method}`, {
        method: method === 'write' ? 'POST' : 'GET',
        headers: {
            ...auth,
            'file-path': Buffer.from(key).toString('hex'),
            ...(method === 'write' ? { 'content-type': 'application/octet-stream' } : {}),
        },
        ...(method === 'write' ? { body: value } : {}),
    })
}

async function expectImportBusy(response: Response): Promise<void> {
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(body).toMatchObject({
        code: 'IMPORT_IN_PROGRESS',
        retryAfter: 5,
        retryable: true,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
    })
}

async function listKeys(
    server: RunningServer,
    auth: AuthHeaders,
    baseline?: Pick<ListResponse, 'timestamp' | 'epoch'>,
): Promise<ListResponse> {
    const response = await fetch(`${server.origin}/api/list`, {
        headers: {
            ...auth,
            ...(baseline ? {
                'x-last-sync': String(baseline.timestamp),
                'x-list-epoch': baseline.epoch,
            } : {}),
        },
    })
    if (!response.ok) throw new Error(`List failed (${response.status}): ${await response.text()}`)
    return await response.json() as ListResponse
}

function partialDatabaseEntry(): Buffer {
    const name = Buffer.from('database.risudat')
    const header = Buffer.alloc(4 + name.length + 4)
    header.writeUInt32LE(name.length, 0)
    name.copy(header, 4)
    header.writeUInt32LE(1024, 4 + name.length)
    return Buffer.concat([header, Buffer.from([0])])
}

function backupEntry(name: string, data: Buffer): Buffer {
    const nameBytes = Buffer.from(name)
    const header = Buffer.alloc(4 + nameBytes.length + 4)
    header.writeUInt32LE(nameBytes.length, 0)
    nameBytes.copy(header, 4)
    header.writeUInt32LE(data.length, 4 + nameBytes.length)
    return Buffer.concat([header, data])
}

function validPluginStorageBackup(key: string, value: Buffer): Buffer {
    const database = {
        characters: [],
        personas: [],
        botPresets: [],
        modules: [],
        pluginCustomStorage: {},
        optimizePluginMemory: true,
    }
    return Buffer.concat([
        backupEntry('database.risudat', Buffer.concat([rawSaveHeader, packr.encode(database)])),
        backupEntry(key, value),
    ])
}

function validDatabaseBackup(): Buffer {
    return validPluginStorageBackup(
        `pluginsave/${Buffer.from('pause-marker').toString('base64url')}.json`,
        Buffer.from('{"pause":true}'),
    )
}

function validDatabaseBytes(note = 'candidate'): Buffer {
    return Buffer.concat([rawSaveHeader, packr.encode({
        characters: [],
        personas: [],
        botPresets: [],
        modules: [],
        pluginCustomStorage: {},
        optimizePluginMemory: true,
        globalNote: note,
    })])
}

function validSaveFolderZip(note = 'candidate'): Buffer {
    const databaseHex = Buffer.from('database/database.bin').toString('hex')
    return Buffer.from(zipSync({
        [databaseHex]: validDatabaseBytes(note),
    }, { level: 0 }))
}

function databaseSpoolDir(cwd: string): string {
    return resolveOwnedSpoolDirFromSave(path.join(cwd, 'save'))
}

function importSpoolArtifacts(cwd: string): string[] {
    const spoolDir = databaseSpoolDir(cwd)
    return fs.readdirSync(spoolDir, { withFileTypes: true })
        .map(entry => entry.name)
        .filter(name => name.startsWith('.backup-import-')
            || name.startsWith('.database-risudat-backup-import-')
            || name.startsWith('.backup-entry-stage-')
            || name.startsWith('.save-folder-import-'))
}

function snapshotRestoreSpoolArtifacts(cwd: string): string[] {
    const spoolDir = databaseSpoolDir(cwd)
    return fs.readdirSync(spoolDir, { withFileTypes: true })
        .map(entry => entry.name)
        .filter(name => name.includes('snapshot-restore'))
}

async function waitForImportCleanup(server: RunningServer, auth: AuthHeaders): Promise<void> {
    await withTimeout((async () => {
        while (true) {
            const response = await fetch(`${server.origin}/api/backup/import/prepare`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ size: 1 }),
            })
            if (response.status === 200) break
            if (response.status !== 409) {
                throw new Error(`Unexpected import prepare status ${response.status}: ${await response.text()}`)
            }
            await delay(10)
        }
        while (importSpoolArtifacts(server.cwd).length > 0) await delay(10)
    })(), 15_000, 'import lifecycle cleanup')
}

async function disconnectAtBarrierDrain(
    server: RunningServer,
    auth: AuthHeaders,
    route: string,
    contentType: string,
    body: Buffer,
): Promise<void> {
    const gateDir = path.join(server.cwd, 'barrier-drain-gate')
    fs.mkdirSync(gateDir, { recursive: true })
    fs.rmSync(path.join(gateDir, 'entered'), { force: true })
    fs.rmSync(path.join(gateDir, 'release'), { force: true })
    fs.writeFileSync(path.join(gateDir, 'hold'), 'hold')

    const request = http.request(`${server.origin}${route}`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': contentType,
            'content-length': String(body.length),
        },
    })
    request.on('error', () => {})
    request.on('response', response => response.resume())
    request.end(body)
    await withTimeout((async () => {
        while (!fs.existsSync(path.join(gateDir, 'entered'))) await delay(10)
    })(), 15_000, `${route} barrier drain`)

    const busy = await fetch(`${server.origin}/api/backup/import/prepare`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ size: 1 }),
    })
    expect(busy.status).toBe(409)
    request.destroy()
    await delay(50)
    const stillBusy = await fetch(`${server.origin}/api/backup/import/prepare`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ size: 1 }),
    })
    expect(stillBusy.status).toBe(409)

    fs.writeFileSync(path.join(gateDir, 'release'), 'release')
    fs.rmSync(path.join(gateDir, 'hold'), { force: true })
    await waitForImportCleanup(server, auth)
    expect(importSpoolArtifacts(server.cwd)).toEqual([])
}

async function startPausedImport(
    server: RunningServer,
    auth: AuthHeaders,
    initialBytes = validDatabaseBackup(),
): Promise<PausedImport> {
    let response: IncomingMessage | undefined
    const gateDir = path.join(server.cwd, 'import-gate')
    fs.mkdirSync(gateDir, { recursive: true })
    fs.rmSync(path.join(gateDir, 'entered'), { force: true })
    fs.rmSync(path.join(gateDir, 'release'), { force: true })
    fs.writeFileSync(path.join(gateDir, 'hold'), 'hold')
    const request = http.request(`${server.origin}/api/backup/import`, {
        method: 'POST',
        headers: {
            ...auth,
            accept: 'application/x-ndjson',
            'content-type': 'application/x-risu-backup',
        },
    })
    request.on('error', () => {})

    let resolveCompleted: (result: { status: number; body: string }) => void
    let rejectCompleted: (error: unknown) => void
    const completed = new Promise<{ status: number; body: string }>((resolveDone, rejectDone) => {
        resolveCompleted = resolveDone
        rejectCompleted = rejectDone
    })
    void completed.catch(() => {})
    const responseReady = new Promise<void>((resolve, reject) => {
        request.once('response', (incoming) => {
            response = incoming
            incoming.setEncoding('utf8')
            let body = ''
            incoming.on('data', (chunk) => {
                body += chunk
            })
            incoming.on('error', (error) => {
                rejectCompleted(error)
            })
            incoming.on('end', () => {
                resolveCompleted({ status: incoming.statusCode ?? 0, body })
            })
            resolve()
        })
        request.once('error', reject)
    })

    request.end(initialBytes)
    await withTimeout((async () => {
        while (!fs.existsSync(path.join(gateDir, 'entered'))) await delay(10)
    })(), 15_000, 'paused import gate')
    await withTimeout(responseReady, 15_000, 'paused import response')
    if (!response) throw new Error('Import response was not created')
    return {
        request,
        response,
        abort: () => {
            response?.destroy()
            request.destroy()
        },
        finish: async () => {
            fs.writeFileSync(path.join(gateDir, 'release'), 'release')
            fs.rmSync(path.join(gateDir, 'hold'), { force: true })
            return await completed
        },
    }
}

afterEach(async () => {
    for (const server of runningServers) {
        await stopServer(server)
    }
    runningServers.clear()
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

describe('list delta import isolation', () => {
    it('holds a delta request until a paused import rolls back', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd)
        const auth = await authenticate(server)
        const seededKey = `pluginsave/${Buffer.from('list-delta-regression').toString('base64url')}.json`
        await seedKey(server, auth, seededKey)
        const baseline = await listKeys(server, auth)
        expect(baseline.mode).toBe('full')
        expect(baseline.content).toContain(seededKey)

        const pausedImport = await startPausedImport(server, auth)
        const pendingList = listKeys(server, auth, baseline)
        const earlyResult = await Promise.race([
            pendingList.then(() => 'resolved'),
            delay(250).then(() => 'pending'),
        ])
        expect(earlyResult).toBe('pending')

        pausedImport.abort()
        const recovered = await withTimeout(pendingList, 15_000, 'post-rollback list')
        expect(recovered.epoch).not.toBe(baseline.epoch)
        expect(recovered.mode).toBe('full')
        expect(recovered.content).toContain(seededKey)
    }, 60_000)

    it('forces a full list after process death during an import', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd)
        const auth = await authenticate(server)
        const seededKey = `pluginsave/${Buffer.from('list-delta-crash-regression').toString('base64url')}.json`
        await seedKey(server, auth, seededKey)
        const baseline = await listKeys(server, auth)
        expect(baseline.mode).toBe('full')
        expect(baseline.content).toContain(seededKey)

        const pausedImport = await startPausedImport(server, auth)
        await stopServer(server, 'SIGKILL')
        pausedImport.abort()

        const restarted = await startServer(cwd)
        // A SIGKILL can occur before a newly-created JWT secret is durable.
        // Re-authenticate against the restarted process; the list generation
        // cursor itself is independent of the bearer token.
        const restartedAuth = await authenticate(restarted)
        const recovered = await listKeys(restarted, restartedAuth, baseline)
        expect(recovered.epoch).not.toBe(baseline.epoch)
        expect(recovered.mode).toBe('full')
        expect(recovered.content).toContain(seededKey)
    }, 60_000)
})

describe('storage reads and mutations during import', () => {
    it('hides transient rows until a held import commits and refuses racing mutations', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd)
        const auth = await authenticate(server)
        const key = 'pluginsave/aGVsZC1jb21taXQ.json'
        const before = Buffer.from('{"generation":"before"}')
        const committed = Buffer.from('{"generation":"committed"}')
        await seedKey(server, auth, key, before)

        const pausedImport = await startPausedImport(
            server,
            auth,
            validPluginStorageBackup(key, committed),
        )
        const pendingRead = readKey(server, auth, key)
        expect(await Promise.race([
            pendingRead.then(() => 'resolved'),
            delay(250).then(() => 'pending'),
        ])).toBe('pending')

        await expectImportBusy(await mutateKeyDuringImport(server, auth, 'write', key))
        await expectImportBusy(await mutateKeyDuringImport(server, auth, 'remove', key))

        const importResult = await withTimeout(pausedImport.finish(), 15_000, 'committed import')
        expect(importResult.status).toBe(200)
        expect(importResult.body).toContain('"type":"done"')
        await expect(withTimeout(pendingRead, 15_000, 'post-commit read'))
            .rejects.toThrow('Read failed (409)')
        // A read submitted before publication may not cross into the imported
        // generation. Refresh database.bin to pin the new generation first.
        expect(await readKey(server, auth, 'database/database.bin')).toBeTruthy()
        expect(await readKey(server, auth, key)).toEqual(committed)
    }, 60_000)

    it('hides transient rows until a held import rolls back and preserves the old commit', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd)
        const auth = await authenticate(server)
        const key = 'pluginsave/aGVsZC1yb2xsYmFjaw.json'
        const before = Buffer.from('{"generation":"before-rollback"}')
        await seedKey(server, auth, key, before)

        const pausedImport = await startPausedImport(server, auth)
        const pendingRead = readKey(server, auth, key)
        expect(await Promise.race([
            pendingRead.then(() => 'resolved'),
            delay(250).then(() => 'pending'),
        ])).toBe('pending')

        await expectImportBusy(await mutateKeyDuringImport(server, auth, 'write', key))
        await expectImportBusy(await mutateKeyDuringImport(server, auth, 'remove', key))

        pausedImport.abort()
        expect(await withTimeout(pendingRead, 15_000, 'post-rollback read')).toEqual(before)
        expect(await readKey(server, auth, key)).toEqual(before)
    }, 60_000)
})

describe('import acquisition lifecycle', () => {
    it('promptly removes a disconnected snapshot restore waiting behind a held import', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd, {
            NODE_OPTIONS: '--trace-warnings',
        })
        const auth = await authenticate(server)
        const snapshotKey = `database/dbbackup-${Math.floor(Date.now() / 100)}.bin`
        const snapshotBytes = validDatabaseBytes('disconnected-restore-must-not-publish')
        await seedKey(server, auth, snapshotKey, snapshotBytes)

        const pausedImport = await startPausedImport(server, auth)
        const restoreBody = JSON.stringify({ key: snapshotKey })
        const restoreRequest = http.request(`${server.origin}/api/db/snapshots/restore`, {
            method: 'POST',
            headers: {
                ...auth,
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(restoreBody)),
            },
        })
        restoreRequest.on('error', () => {})
        restoreRequest.on('response', response => response.resume())
        restoreRequest.end(restoreBody)
        await withTimeout(new Promise<void>((resolve) => {
            if (restoreRequest.writableFinished) resolve()
            else restoreRequest.once('finish', resolve)
        }), 5_000, 'queued snapshot restore upload')
        await delay(100)
        restoreRequest.destroy()

        // This warning is emitted only after the route leaves acquire(). Seeing
        // it while the original importer is still held proves the disconnected
        // waiter was removed promptly rather than waking after holder release.
        await withTimeout((async () => {
            while (!server.logs().includes(
                '[Snapshot Restore] Client disconnected before publication; partial spool was discarded',
            )) await delay(10)
        })(), 5_000, 'queued snapshot restore cancellation')
        expect(snapshotRestoreSpoolArtifacts(cwd)).toEqual([])

        const importResult = await withTimeout(pausedImport.finish(), 15_000, 'held import release')
        expect(importResult.status, importResult.body).toBe(200)
        const postImportDatabase = await readKey(server, auth, 'database/database.bin')
        expect(postImportDatabase).toBeTruthy()
        await delay(100)
        expect(await readKey(server, auth, 'database/database.bin')).toEqual(postImportDatabase)
        expect(snapshotRestoreSpoolArtifacts(cwd)).toEqual([])

        const admittedRestore = await fetch(`${server.origin}/api/db/snapshots/restore`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: restoreBody,
        })
        expect(admittedRestore.status).toBe(200)
        expect(await admittedRestore.json()).toEqual({
            ok: true,
            key: snapshotKey,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
        })
        expect(await readKey(server, auth, 'database/database.bin')).not.toEqual(postImportDatabase)
        expect(snapshotRestoreSpoolArtifacts(cwd)).toEqual([])
        expect(server.logs()).not.toMatch(/MaxListenersExceededWarning|Possible EventEmitter memory leak/)
    }, 60_000)

    it('cancels archive and save-folder uploads disconnected during the mutation drain', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd, {
            POCKETRISU_IMPORT_BARRIER_DRAIN_TEST_GATE_DIR: path.join(cwd, 'barrier-drain-gate'),
        })
        const auth = await authenticate(server)
        const durableKey = `pluginsave/${Buffer.from('drain-durable').toString('base64url')}.json`
        const durable = Buffer.from('{"generation":"before-drain"}')
        await seedKey(server, auth, durableKey, durable)

        await disconnectAtBarrierDrain(
            server,
            auth,
            '/api/backup/import',
            'application/x-risu-backup',
            validDatabaseBackup(),
        )
        expect(await readKey(server, auth, durableKey)).toEqual(durable)

        await disconnectAtBarrierDrain(
            server,
            auth,
            '/api/migrate/save-folder/upload',
            'application/zip',
            validSaveFolderZip('must-not-publish'),
        )
        expect(await readKey(server, auth, durableKey)).toEqual(durable)

        const admitted = await fetch(`${server.origin}/api/backup/import`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/x-risu-backup' },
            body: validDatabaseBackup(),
        })
        expect(admitted.status).toBe(200)
    }, 60_000)

    it('clears the import slot after forced acquisition rejection on all four routes', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd, {
            POCKETRISU_TEST_IMPORT_BARRIER_ACQUIRE_FAILURES: '4',
        })
        const auth = await authenticate(server)
        const directDir = path.join(cwd, 'direct-import')
        fs.mkdirSync(directDir)
        fs.writeFileSync(
            path.join(directDir, Buffer.from('database/database.bin').toString('hex')),
            validDatabaseBytes('direct'),
        )
        const requests: Array<() => Promise<Response>> = [
            () => fetch(`${server.origin}/api/backup/import`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/x-risu-backup' },
                body: validDatabaseBackup(),
            }),
            () => fetch(`${server.origin}/api/backup/server/restore`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ filename: 'risu-backup-1.bin' }),
            }),
            () => fetch(`${server.origin}/api/migrate/save-folder/execute`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ path: directDir }),
            }),
            () => fetch(`${server.origin}/api/migrate/save-folder/upload`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/zip' },
                body: validSaveFolderZip('zip'),
            }),
        ]

        for (const issueRequest of requests) {
            const response = await issueRequest()
            expect(response.status).toBe(500)
            expect(await response.json()).toMatchObject({
                code: 'IMPORT_BARRIER_ACQUIRE_FAILED',
                retryable: true,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            })
            await waitForImportCleanup(server, auth)
            expect(importSpoolArtifacts(server.cwd)).toEqual([])
        }

        const admitted = await fetch(`${server.origin}/api/backup/import`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/x-risu-backup' },
            body: validDatabaseBackup(),
        })
        expect(admitted.status).toBe(200)
    }, 60_000)
})

describe('backup import NDJSON lifecycle', () => {
    it('keeps server restore alive with immediate and periodic heartbeats', async () => {
        const cwd = makeWorkDir()
        fs.mkdirSync(path.join(cwd, 'backups'))
        fs.writeFileSync(path.join(cwd, 'backups', 'risu-backup-1.bin'), validDatabaseBackup())
        const server = await startServer(cwd, { BACKUP_NDJSON_HEARTBEAT_MS: '100' })
        const auth = await authenticate(server)
        const gateDir = path.join(cwd, 'import-gate')
        fs.mkdirSync(gateDir, { recursive: true })
        fs.rmSync(path.join(gateDir, 'entered'), { force: true })
        fs.rmSync(path.join(gateDir, 'release'), { force: true })
        fs.writeFileSync(path.join(gateDir, 'hold'), 'hold')

        const response = await fetch(`${server.origin}/api/backup/server/restore`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'risu-backup-1.bin' }),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-cache, no-transform')
        expect(response.headers.get('x-accel-buffering')).toBe('no')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let text = ''
        await withTimeout((async () => {
            while (!fs.existsSync(path.join(gateDir, 'entered'))) await delay(10)
            while ((text.match(/"type":"heartbeat"/g) ?? []).length < 2) {
                const { done, value } = await reader.read()
                if (done) throw new Error('restore stream ended before periodic heartbeat')
                text += decoder.decode(value, { stream: true })
            }
        })(), 15_000, 'restore periodic heartbeat')

        fs.writeFileSync(path.join(gateDir, 'release'), 'release')
        fs.rmSync(path.join(gateDir, 'hold'), { force: true })
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
        expect(text).toContain('"type":"done"')
    }, 60_000)

    it('emits the same exact structured late error for upload and server restore', async () => {
        const cwd = makeWorkDir()
        fs.mkdirSync(path.join(cwd, 'backups'))
        fs.writeFileSync(path.join(cwd, 'backups', 'risu-backup-1.bin'), validDatabaseBackup())
        const baseline = await startServer(cwd)
        const baselineAuth = await authenticate(baseline)
        const durableKey = `pluginsave/${Buffer.from('late-error-durable').toString('base64url')}.json`
        const durable = Buffer.from('{"generation":"before-late-error"}')
        await seedKey(baseline, baselineAuth, durableKey, durable)
        await stopServer(baseline)

        const server = await startServer(cwd, {
            POCKETRISU_TEST_BACKUP_IMPORT_FAILPOINT: 'after-database-ingestion',
            BACKUP_NDJSON_HEARTBEAT_MS: '100',
        })
        const auth = await authenticate(server)
        const requests = [
            () => fetch(`${server.origin}/api/backup/import`, {
                method: 'POST',
                headers: {
                    ...auth,
                    accept: 'application/x-ndjson',
                    'content-type': 'application/x-risu-backup',
                },
                body: validDatabaseBackup(),
            }),
            () => fetch(`${server.origin}/api/backup/server/restore`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ filename: 'risu-backup-1.bin' }),
            }),
        ]
        for (const issueRequest of requests) {
            const response = await issueRequest()
            expect(response.status).toBe(200)
            const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
            expect(events.some(event => event.type === 'done')).toBe(false)
            expect(events.find(event => event.type === 'error')).toEqual({
                type: 'error',
                message: 'Backup import was rolled back before publication',
                code: 'BACKUP_IMPORT_NOT_COMMITTED',
                retryable: true,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                status: 500,
            })
            expect(await readKey(server, auth, durableKey)).toEqual(durable)
        }
    }, 60_000)
})
