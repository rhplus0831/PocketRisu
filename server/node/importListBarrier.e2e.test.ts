import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http, { type ClientRequest, type IncomingMessage } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Packr } from 'msgpackr'

const serverEntry = path.resolve(process.cwd(), 'server/node/server.cjs')
const testPasswordDigest = crypto.createHash('sha256').update('list-delta-test').digest('hex')

interface RunningServer {
    child: ChildProcessWithoutNullStreams
    origin: string
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

async function startServer(cwd: string): Promise<RunningServer> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const port = await getFreePort()
        let output = ''
        const child = spawn(process.execPath, [serverEntry], {
            cwd,
            env: {
                ...process.env,
                HOST: '127.0.0.1',
                PORT: String(port),
                RISU_UPDATE_CHECK: 'false',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        child.stdout.on('data', (chunk) => { output += chunk.toString() })
        child.stderr.on('data', (chunk) => { output += chunk.toString() })
        const server = {
            child,
            origin: `http://127.0.0.1:${port}`,
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
    const response = await fetch(`${server.origin}/api/write`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key).toString('hex'),
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

async function startPausedImport(
    server: RunningServer,
    auth: AuthHeaders,
    initialBytes = partialDatabaseEntry(),
): Promise<PausedImport> {
    let response: IncomingMessage | undefined
    let progressSeen = false
    const request = http.request(`${server.origin}/api/backup/import`, {
        method: 'POST',
        headers: {
            ...auth,
            accept: 'application/x-ndjson',
            'content-type': 'application/x-risu-backup',
        },
    })
    request.on('error', () => {})

    let finishImport: (() => Promise<{ status: number; body: string }>) | undefined
    const progress = new Promise<void>((resolve, reject) => {
        request.once('response', (incoming) => {
            response = incoming
            incoming.setEncoding('utf8')
            let body = ''
            let resolveCompleted: (result: { status: number; body: string }) => void
            let rejectCompleted: (error: unknown) => void
            const completed = new Promise<{ status: number; body: string }>((resolveDone, rejectDone) => {
                resolveCompleted = resolveDone
                rejectCompleted = rejectDone
            })
            // Rollback/crash tests intentionally destroy this response instead
            // of awaiting finish(); keep that expected rejection handled.
            void completed.catch(() => {})
            finishImport = async () => {
                request.end()
                return await completed
            }
            incoming.on('data', (chunk) => {
                body += chunk
                if (!progressSeen && body.includes('"type":"progress"')) {
                    progressSeen = true
                    resolve()
                }
            })
            incoming.on('error', (error) => {
                if (!progressSeen) reject(error)
                rejectCompleted(error)
            })
            incoming.on('end', () => {
                if (!progressSeen) reject(new Error(`Import ended before pausing: ${body}`))
                resolveCompleted({ status: incoming.statusCode ?? 0, body })
            })
        })
    })

    request.write(initialBytes)
    await withTimeout(progress, 15_000, 'paused import progress')
    if (!response || !finishImport) throw new Error('Import response was not created')
    return {
        request,
        response,
        abort: () => {
            response?.destroy()
            request.destroy()
        },
        finish: finishImport,
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
        const recovered = await listKeys(restarted, auth, baseline)
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
        expect(await withTimeout(pendingRead, 15_000, 'post-commit read')).toEqual(committed)
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
