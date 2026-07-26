import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import utilsPkg from './utils.cjs'
import pluginSaveKeysPkg from './pluginSaveKeys.cjs'
import streamLoadPkg from './streamRisuLoad.cjs'

const { decodeRisuSave, encodeRisuSaveLegacy } = utilsPkg as {
    decodeRisuSave: (value: Buffer) => Promise<any>
    encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}
const { shouldStreamRisuSave } = streamLoadPkg as {
    shouldStreamRisuSave: (input: Buffer, options?: { minBytes?: number }) => Promise<boolean>
}
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    encodePluginSaveStorageKey,
} = pluginSaveKeysPkg as {
    PLUGIN_SAVE_PREFIX: string
    PLUGIN_SAVE_META_PREFIX: string
    encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
}

const serverEntry = path.resolve(process.cwd(), 'server/node/server.cjs')
const testPasswordDigest = crypto.createHash('sha256').update('snapshot-plugin-test').digest('hex')

interface RunningServer {
    child: ChildProcessWithoutNullStreams
    origin: string
    logs: () => string
}

interface AuthHeaders {
    'risu-auth': string
    'x-session-id': string
}

const runningServers = new Set<RunningServer>()
const tempDirs: string[] = []

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
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

async function stopServer(server: RunningServer): Promise<void> {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => server.child.once('exit', () => resolve()))
    server.child.kill('SIGTERM')
    const stopped = await Promise.race([
        exited.then(() => true),
        delay(5_000).then(() => false),
    ])
    if (!stopped && server.child.exitCode === null && server.child.signalCode === null) {
        server.child.kill('SIGKILL')
        await exited
    }
    runningServers.delete(server)
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
                RISU_UPDATE_CHECK: 'false',
                POCKETRISU_BACKUP_INTERVAL_MS: '1',
                ...extraEnv,
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
            if (!output.includes('EADDRINUSE') || attempt === 2) throw error
        }
    }
    throw new Error('Could not start test server')
}

function makeWorkDir(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-snapshot-plugin-'))
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
    const session = await fetch(`${server.origin}/api/session`, { method: 'POST', headers })
    if (!session.ok) throw new Error(`Session registration failed (${session.status})`)
    return headers
}

async function writeKey(server: RunningServer, auth: AuthHeaders, key: string, body: Uint8Array): Promise<void> {
    const response = await fetch(`${server.origin}/api/write`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key).toString('hex'),
        },
        body,
    })
    if (!response.ok) throw new Error(`Write of ${key} failed (${response.status}): ${await response.text()}`)
}

async function readKey(server: RunningServer, auth: AuthHeaders, key: string): Promise<Buffer> {
    const response = await fetch(`${server.origin}/api/read`, {
        headers: { ...auth, 'file-path': Buffer.from(key).toString('hex') },
    })
    if (!response.ok) throw new Error(`Read of ${key} failed (${response.status}): ${await response.text()}`)
    return Buffer.from(await response.arrayBuffer())
}

async function removeKey(server: RunningServer, auth: AuthHeaders, key: string): Promise<void> {
    const response = await fetch(`${server.origin}/api/remove`, {
        headers: { ...auth, 'file-path': Buffer.from(key).toString('hex') },
    })
    if (!response.ok) throw new Error(`Remove of ${key} failed (${response.status}): ${await response.text()}`)
}

async function listSnapshotKeys(server: RunningServer, auth: AuthHeaders): Promise<string[]> {
    const response = await fetch(`${server.origin}/api/db/snapshots`, { headers: auth })
    if (!response.ok) throw new Error(`Snapshot list failed (${response.status}): ${await response.text()}`)
    const { snapshots } = await response.json() as { snapshots: Array<{ key: string }> }
    return snapshots.map((snapshot) => snapshot.key)
}

async function restoreSnapshot(server: RunningServer, auth: AuthHeaders, key: string): Promise<void> {
    const response = await fetch(`${server.origin}/api/db/snapshots/restore`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
    })
    if (!response.ok) throw new Error(`Restore of ${key} failed (${response.status}): ${await response.text()}`)
}

// Enough top-level bulk that the snapshot clears a low
// RISU_STREAM_INGEST_MIN_BYTES, so the streaming variant genuinely streams.
function buildDatabase(pluginStorage: {
    values?: Record<string, unknown>
    meta?: Record<string, unknown>
}): Uint8Array {
    const dbObj: Record<string, unknown> = {
        characters: [],
        optimizePluginMemory: true,
        pluginCustomStorage: pluginStorage.values ?? {},
        formatPadding: 'x'.repeat(4096),
    }
    if (pluginStorage.meta !== undefined) {
        dbObj.pluginStorageMeta = pluginStorage.meta
    }
    return encodeRisuSaveLegacy(dbObj)
}

const valueRowKey = (rawKey: string) => encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_PREFIX)
const metaRowKey = (rawKey: string) => encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_META_PREFIX)

afterEach(async () => {
    await Promise.all([...runningServers].map((server) => stopServer(server)))
    await Promise.all(tempDirs.splice(0).map(
        (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
    ))
})

// The audit regression (docs/audit/snapshots-omit-optimized-plugin-storage.md):
// snapshot V1 → change to V2, delete an old key, add a new key → restore →
// the exact snapshot-time key set and values must come back.
async function runRoundTrip(options: { streamIngestMinBytes?: number }): Promise<void> {
    const extraEnv = options.streamIngestMinBytes !== undefined
        ? { RISU_STREAM_INGEST_MIN_BYTES: String(options.streamIngestMinBytes) }
        : {}
    const server = await startServer(makeWorkDir(), extraEnv)
    const auth = await authenticate(server)

    await writeKey(server, auth, 'database/database.bin', buildDatabase({
        values: { keyA: 'V1', keyB: { keep: true } },
        meta: { keyA: { quota: 1 } },
    }))

    const snapshots = await listSnapshotKeys(server, auth)
    expect(snapshots.length).toBe(1)

    // Creation-side canary: the snapshot itself carries the folded values and
    // the marker, not the optimized stub's empty maps.
    const snapshotBlob = await readKey(server, auth, snapshots[0])
    // Prove which restore branch the server under test will take — both paths
    // produce identical observable results, so a silent fall-through here
    // would leave one of them untested.
    await expect(shouldStreamRisuSave(snapshotBlob, {
        minBytes: options.streamIngestMinBytes,
    })).resolves.toBe(options.streamIngestMinBytes !== undefined)
    const snapshotDb = await decodeRisuSave(snapshotBlob)
    expect(snapshotDb.pluginStorageFolded).toBe(true)
    expect(snapshotDb.pluginCustomStorage).toEqual({ keyA: 'V1', keyB: { keep: true } })
    expect(snapshotDb.pluginStorageMeta).toEqual({ keyA: { quota: 1 } })

    await writeKey(server, auth, valueRowKey('keyA'), Buffer.from(JSON.stringify('V2')))
    await removeKey(server, auth, valueRowKey('keyB'))
    await writeKey(server, auth, valueRowKey('keyC'), Buffer.from(JSON.stringify('added-later')))
    await removeKey(server, auth, metaRowKey('keyA'))

    await restoreSnapshot(server, auth, snapshots[0])

    expect(JSON.parse((await readKey(server, auth, valueRowKey('keyA'))).toString('utf-8'))).toBe('V1')
    expect(JSON.parse((await readKey(server, auth, valueRowKey('keyB'))).toString('utf-8'))).toEqual({ keep: true })
    expect((await readKey(server, auth, valueRowKey('keyC'))).length).toBe(0)
    expect(JSON.parse((await readKey(server, auth, metaRowKey('keyA'))).toString('utf-8'))).toEqual({ quota: 1 })

    // The restored live DB stays in optimized stub shape; the snapshot-only
    // marker must never leak into database.bin.
    const liveDb = await decodeRisuSave(await readKey(server, auth, 'database/database.bin'))
    expect(liveDb.optimizePluginMemory).toBe(true)
    expect(liveDb.pluginCustomStorage).toEqual({})
    expect(liveDb.pluginStorageMeta).toBeUndefined()
    expect(liveDb.pluginStorageFolded).toBeUndefined()
}

describe('automatic snapshots × optimized plugin storage', () => {
    it('rolls back a rejected legacy snapshot before replacing live plugin state', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { durable: { generation: 'live' } },
            meta: { durable: { plugin: 'Live Plugin', updatedAt: 1 } },
        }))
        const snapshotKey = `database/dbbackup-${((Date.now() + 60_000) / 100).toFixed()}.bin`
        await writeKey(server, auth, snapshotKey, buildDatabase({
            values: { invalid: Number.POSITIVE_INFINITY },
        }))

        const liveBefore = await readKey(server, auth, 'database/database.bin')
        const valueBefore = await readKey(server, auth, valueRowKey('durable'))
        const metaBefore = await readKey(server, auth, metaRowKey('durable'))
        const migrationMarkerBefore = await readKey(
            server,
            auth,
            'migration/disable-remote-saving',
        )
        const response = await fetch(`${server.origin}/api/db/snapshots/restore`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ key: snapshotKey }),
        })

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'Invalid plugin storage JSON row',
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: valueRowKey('invalid'),
        })
        expect(await readKey(server, auth, 'database/database.bin')).toEqual(liveBefore)
        expect(await readKey(server, auth, valueRowKey('durable'))).toEqual(valueBefore)
        expect(await readKey(server, auth, metaRowKey('durable'))).toEqual(metaBefore)
        expect(await readKey(server, auth, 'migration/disable-remote-saving'))
            .toEqual(migrationMarkerBefore)
    })

    it('rejects malformed direct plugin-row writes without replacing durable data', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)
        const key = valueRowKey('write-boundary')
        await writeKey(server, auth, key, Buffer.from('{"durable":true}'))

        for (const invalid of [Buffer.from('{"unfinished":'), Buffer.from([0xff])]) {
            const response = await fetch(`${server.origin}/api/write`, {
                method: 'POST',
                headers: {
                    ...auth,
                    'content-type': 'application/octet-stream',
                    'file-path': Buffer.from(key).toString('hex'),
                },
                body: invalid,
            })
            expect(response.status).toBe(400)
            await expect(response.json()).resolves.toEqual({
                error: 'Invalid plugin storage JSON row',
                code: 'INVALID_PLUGIN_STORAGE_ROW',
                encodedKey: key,
            })
            expect(JSON.parse((await readKey(server, auth, key)).toString('utf-8')))
                .toEqual({ durable: true })
        }
    })

    it('keeps direct and folded validation diagnostics encoded-key-only', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)
        const decodedKey = 'decoded/private-plugin-key'
        const secretValue = 'SECRET_PLUGIN_VALUE'
        const key = valueRowKey(decodedKey)

        const directResponse = await fetch(`${server.origin}/api/write`, {
            method: 'POST',
            headers: {
                ...auth,
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(key).toString('hex'),
            },
            body: Buffer.from(`{"${secretValue}":`),
        })
        expect(directResponse.status).toBe(400)
        await expect(directResponse.json()).resolves.toEqual({
            error: 'Invalid plugin storage JSON row',
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: key,
        })

        const malformedKey = 'pluginsave/decoded-private-key'
        const malformedResponse = await fetch(`${server.origin}/api/write`, {
            method: 'POST',
            headers: {
                ...auth,
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(malformedKey).toString('hex'),
            },
            body: Buffer.from('1'),
        })
        expect(malformedResponse.status).toBe(400)
        await expect(malformedResponse.json()).resolves.toEqual({
            error: 'Invalid plugin storage JSON row',
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: PLUGIN_SAVE_PREFIX,
        })

        const foldedResponse = await fetch(`${server.origin}/api/write`, {
            method: 'POST',
            headers: {
                ...auth,
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from('database/database.bin').toString('hex'),
            },
            body: buildDatabase({
                values: {
                    [decodedKey]: { [secretValue]: Number.POSITIVE_INFINITY },
                },
            }),
        })
        expect(foldedResponse.status).toBe(400)
        await expect(foldedResponse.json()).resolves.toEqual({
            error: 'Invalid plugin storage JSON row',
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: key,
        })

        await delay(20)
        expect(server.logs()).not.toContain(decodedKey)
        expect(server.logs()).not.toContain(malformedKey)
        expect(server.logs()).not.toContain(secretValue)
    })

    it('keeps streaming-ingest validation diagnostics encoded-key-only', async () => {
        const cwd = makeWorkDir()
        let server = await startServer(cwd, { RISU_STREAM_INGEST_MIN_BYTES: '1024' })
        const decodedKey = 'decoded/private-stream-key'
        const secretValue = 'SECRET_STREAM_VALUE'
        const snapshotKey = `database/dbbackup-${((Date.now() + 60_000) / 100).toFixed()}.bin`

        await stopServer(server)
        const raw = new Database(path.join(cwd, 'save', 'risuai.db'))
        raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            snapshotKey,
            Buffer.from(encodeRisuSaveLegacy({
                characters: [],
                optimizePluginMemory: true,
                pluginStorageFolded: true,
                pluginCustomStorage: {
                    [decodedKey]: { [secretValue]: Number.POSITIVE_INFINITY },
                },
                formatPadding: 'x'.repeat(4096),
            })),
            Date.now(),
        )
        raw.close()

        server = await startServer(cwd, { RISU_STREAM_INGEST_MIN_BYTES: '1024' })
        const auth = await authenticate(server)
        const response = await fetch(`${server.origin}/api/db/snapshots/restore`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ key: snapshotKey }),
        })
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'Invalid plugin storage JSON row',
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: valueRowKey(decodedKey),
        })

        await delay(20)
        expect(server.logs()).not.toContain(decodedKey)
        expect(server.logs()).not.toContain(secretValue)
    })

    it('forces streaming record-shape validation before the empty-row gate', async () => {
        const cwd = makeWorkDir()
        let server = await startServer(cwd, { RISU_STREAM_INGEST_MIN_BYTES: '1024' })
        await stopServer(server)
        const snapshots = [
            {
                key: `database/dbbackup-${((Date.now() + 120_000) / 100).toFixed()}.bin`,
                database: {
                    characters: [],
                    optimizePluginMemory: true,
                    pluginCustomStorage: [],
                    formatPadding: 'x'.repeat(4096),
                },
                encodedKey: PLUGIN_SAVE_PREFIX,
            },
            {
                key: `database/dbbackup-${((Date.now() + 180_000) / 100).toFixed()}.bin`,
                database: {
                    characters: [],
                    optimizePluginMemory: false,
                    pluginStorageFolded: true,
                    pluginCustomStorage: {},
                    pluginStorageMeta: null,
                    formatPadding: 'x'.repeat(4096),
                },
                encodedKey: PLUGIN_SAVE_META_PREFIX,
            },
        ]
        const raw = new Database(path.join(cwd, 'save', 'risuai.db'))
        const insert = raw.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)'
        )
        for (const snapshot of snapshots) {
            insert.run(
                snapshot.key,
                Buffer.from(encodeRisuSaveLegacy(snapshot.database)),
                Date.now(),
            )
        }
        raw.close()

        server = await startServer(cwd, { RISU_STREAM_INGEST_MIN_BYTES: '1024' })
        const auth = await authenticate(server)
        for (const snapshot of snapshots) {
            const blob = await readKey(server, auth, snapshot.key)
            await expect(shouldStreamRisuSave(blob, { minBytes: 1024 })).resolves.toBe(true)
            const response = await fetch(`${server.origin}/api/db/snapshots/restore`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ key: snapshot.key }),
            })
            expect(response.status).toBe(400)
            await expect(response.json()).resolves.toEqual({
                error: 'Invalid plugin storage JSON row',
                code: 'INVALID_PLUGIN_STORAGE_ROW',
                encodedKey: snapshot.encodedKey,
            })
        }
    })

    it('restores snapshot-time plugin rows exactly (legacy ingest path)', async () => {
        await runRoundTrip({})
    })

    it('restores snapshot-time plugin rows exactly (streaming ingest path)', async () => {
        await runRoundTrip({ streamIngestMinBytes: 1024 })
    })

    it('restoring a folded-empty snapshot clears plugin rows added afterwards', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)

        await writeKey(server, auth, 'database/database.bin', buildDatabase({ values: {} }))
        const snapshots = await listSnapshotKeys(server, auth)
        expect(snapshots.length).toBe(1)

        await writeKey(server, auth, valueRowKey('keyX'), Buffer.from(JSON.stringify('post-snapshot')))
        await restoreSnapshot(server, auth, snapshots[0])

        expect((await readKey(server, auth, valueRowKey('keyX'))).length).toBe(0)
    })

    it('restoring a pre-fix stub snapshot leaves current plugin rows untouched', async () => {
        const cwd = makeWorkDir()
        let server = await startServer(cwd)
        let auth = await authenticate(server)

        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { keyP: 'V1' },
        }))
        await stopServer(server)

        // A snapshot created before the fix: the optimized stub itself, with
        // empty inline maps and no folded marker. Insert it directly so the
        // fixed server has to handle the legacy artifact.
        const stubTimestamp = ((Date.now() + 60_000) / 100).toFixed()
        const stubKey = `database/dbbackup-${stubTimestamp}.bin`
        const raw = new Database(path.join(cwd, 'save', 'risuai.db'))
        raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            stubKey,
            Buffer.from(encodeRisuSaveLegacy({
                characters: [],
                optimizePluginMemory: true,
                pluginCustomStorage: {},
                formatPadding: 'x'.repeat(4096),
            })),
            Date.now(),
        )
        raw.close()

        server = await startServer(cwd)
        auth = await authenticate(server)

        await writeKey(server, auth, valueRowKey('keyP'), Buffer.from(JSON.stringify('V2')))
        await restoreSnapshot(server, auth, stubKey)

        // Unmarked snapshots carry no plugin data to restore from; wiping the
        // rows here would lose the only surviving copy.
        expect(JSON.parse((await readKey(server, auth, valueRowKey('keyP'))).toString('utf-8'))).toBe('V2')
    })
})
