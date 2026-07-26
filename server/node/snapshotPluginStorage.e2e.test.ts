import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import utilsPkg from './utils.cjs'
import pluginSaveKeysPkg from './pluginSaveKeys.cjs'
import streamLoadPkg from './streamRisuLoad.cjs'
import { encodeBackup } from '../../test/compat/helpers/encode.js'

const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    calculateHash,
    normalizeJSON,
    magicCompressedHeader,
} = utilsPkg as {
    decodeRisuSave: (value: Buffer) => Promise<any>
    encodeRisuSaveLegacy: (value: unknown) => Uint8Array
    calculateHash: (value: unknown) => number
    normalizeJSON: (value: unknown) => any
    magicCompressedHeader: Uint8Array
}
const { shouldStreamRisuSave } = streamLoadPkg as {
    shouldStreamRisuSave: (input: Buffer, options?: { minBytes?: number }) => Promise<boolean>
}
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_STORAGE_MANIFEST_KEY,
    encodePluginSaveStorageKey,
} = pluginSaveKeysPkg as {
    PLUGIN_SAVE_PREFIX: string
    PLUGIN_SAVE_META_PREFIX: string
    PLUGIN_STORAGE_MANIFEST_KEY: string
    encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
}

const serverEntry = path.resolve(process.cwd(), 'server/node/server.cjs')
const testPasswordDigest = crypto.createHash('sha256').update('snapshot-plugin-test').digest('hex')
const packr = new Packr({ useRecords: false })
const pluginRecoveryDirtyKey = 'config/plugin-storage-recovery-dirty'

interface RunningServer {
    child: ChildProcessWithoutNullStreams
    origin: string
    logs: () => string
}

interface AuthHeaders {
    'risu-auth': string
    'x-session-id': string
    cookie?: string
}

const runningServers = new Set<RunningServer>()
const tempDirs: string[] = []

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(
    predicate: () => Promise<boolean>,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = null
    while (Date.now() < deadline) {
        try {
            if (await predicate()) return
        } catch (error) {
            lastError = error
        }
        await delay(25)
    }
    if (lastError) throw lastError
    throw new Error(`Condition did not settle within ${timeoutMs}ms`)
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

function openFixtureDatabase(cwd: string) {
    const raw = new Database(path.join(cwd, 'save', 'risuai.db'))
    raw.exec(`
        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `)
    return raw
}

function replacePluginPublicationOutsideServer(
    cwd: string,
    {
        rawKey,
        value,
        meta,
        recoveryToken,
    }: {
        rawKey: string
        value: unknown
        meta: unknown
        recoveryToken: string
    },
): void {
    const raw = openFixtureDatabase(cwd)
    const set = raw.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    raw.transaction(() => {
        const now = Date.now()
        set.run(valueRowKey(rawKey), Buffer.from(JSON.stringify(value)), now)
        set.run(metaRowKey(rawKey), Buffer.from(JSON.stringify(meta)), now)
        set.run(pluginRecoveryDirtyKey, Buffer.from(recoveryToken), now)
    })()
    raw.close()
}

async function armSnapshotPublicationGate(gateDir: string): Promise<void> {
    await fs.promises.mkdir(gateDir, { recursive: true })
    await fs.promises.writeFile(path.join(gateDir, 'hold'), 'hold')
}

async function waitForSnapshotPublicationGate(gateDir: string): Promise<void> {
    await waitFor(async () => fs.existsSync(path.join(gateDir, 'entered')))
}

async function releaseSnapshotPublicationGate(gateDir: string): Promise<void> {
    await fs.promises.writeFile(path.join(gateDir, 'release'), 'release')
}

async function disarmSnapshotPublicationGate(gateDir: string): Promise<void> {
    await Promise.all(['hold', 'entered', 'release'].map(
        (name) => fs.promises.rm(path.join(gateDir, name), { force: true }),
    ))
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
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie) headers.cookie = cookie
    return headers
}

async function writeKeyResponse(
    server: RunningServer,
    auth: AuthHeaders,
    key: string,
    body: Uint8Array,
): Promise<Response> {
    return await fetch(`${server.origin}/api/write`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key).toString('hex'),
        },
        body,
    })
}

async function writeKey(server: RunningServer, auth: AuthHeaders, key: string, body: Uint8Array): Promise<void> {
    const response = await writeKeyResponse(server, auth, key, body)
    if (!response.ok) throw new Error(`Write of ${key} failed (${response.status}): ${await response.text()}`)
}

async function readKeyResponse(
    server: RunningServer,
    auth: AuthHeaders,
    key: string,
    generation?: string,
): Promise<Response> {
    return await fetch(`${server.origin}/api/read`, {
        headers: {
            ...auth,
            'file-path': Buffer.from(key).toString('hex'),
            ...(generation ? { 'x-plugin-storage-generation': generation } : {}),
        },
    })
}

async function readKey(
    server: RunningServer,
    auth: AuthHeaders,
    key: string,
    generation?: string,
): Promise<Buffer> {
    const response = await readKeyResponse(server, auth, key, generation)
    if (!response.ok) throw new Error(`Read of ${key} failed (${response.status}): ${await response.text()}`)
    return Buffer.from(await response.arrayBuffer())
}

async function removeKeyResponse(
    server: RunningServer,
    auth: AuthHeaders,
    key: string,
): Promise<Response> {
    return await fetch(`${server.origin}/api/remove`, {
        headers: { ...auth, 'file-path': Buffer.from(key).toString('hex') },
    })
}

async function removeKey(server: RunningServer, auth: AuthHeaders, key: string): Promise<void> {
    const response = await removeKeyResponse(server, auth, key)
    if (!response.ok) throw new Error(`Remove of ${key} failed (${response.status}): ${await response.text()}`)
}

async function bulkWriteResponse(
    server: RunningServer,
    auth: AuthHeaders,
    entries: Array<{ key: string; value: Uint8Array }>,
): Promise<Response> {
    return await fetch(`${server.origin}/api/assets/bulk-write`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(entries.map(({ key, value }) => ({
            key,
            value: Buffer.from(value).toString('base64'),
        }))),
    })
}

async function patchDatabaseResponse(
    server: RunningServer,
    auth: AuthHeaders,
    expectedHash: string,
    patch: unknown[],
): Promise<Response> {
    return await fetch(`${server.origin}/api/patch`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/json',
            'file-path': Buffer.from('database/database.bin').toString('hex'),
        },
        body: JSON.stringify({ expectedHash, patch }),
    })
}

async function flushDatabase(server: RunningServer, auth: AuthHeaders): Promise<void> {
    const response = await fetch(`${server.origin}/api/db/flush`, {
        method: 'POST',
        headers: auth,
    })
    if (!response.ok) {
        throw new Error(`Database flush failed (${response.status}): ${await response.text()}`)
    }
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

function manifestBytes(generation: string, valueKeys: string[], metaKeys: string[] = []): Buffer {
    return Buffer.from(JSON.stringify({
        version: 1,
        generation,
        valueKeys,
        metaKeys,
    }))
}

function lateFailingDatabase(payloadBytes = 64 * 1024): Buffer {
    const gzipped = gzipSync(packr.encode({
        characters: [{
            chaId: 'plugin-snapshot-import',
            name: 'Import barrier',
            chats: [{
                id: 'plugin-snapshot-import-chat',
                message: [{ role: 'char', data: 'x'.repeat(payloadBytes) }],
            }],
        }],
    }), { level: 1 })
    gzipped[gzipped.length - 1] ^= 0xff
    return Buffer.concat([Buffer.from(magicCompressedHeader), gzipped])
}

async function transitionStorage(
    server: RunningServer,
    auth: AuthHeaders,
    source: { optimized: boolean; generation: string | null; manifest: unknown },
    database: Uint8Array,
    failpoint?: string,
): Promise<Response> {
    return await fetch(`${server.origin}/api/plugin-storage/transition`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            ...(failpoint ? { 'x-plugin-storage-failpoint': failpoint } : {}),
        },
        body: encodeRisuSaveLegacy({
            version: 1,
            source,
            database,
        }),
    })
}

async function mutateStorage(
    server: RunningServer,
    auth: AuthHeaders,
    plan: unknown,
    failpoint?: string,
): Promise<Response> {
    return await fetch(`${server.origin}/api/plugin-storage/mutate`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            ...(failpoint ? { 'x-plugin-storage-failpoint': failpoint } : {}),
        },
        body: encodeRisuSaveLegacy(plan),
    })
}

async function mutateActualPluginStorage(
    server: RunningServer,
    auth: AuthHeaders,
    {
        rawKey,
        operation,
        generation,
        value,
        owner = '',
    }: {
        rawKey: string
        operation: 'set' | 'remove'
        generation: string
        value?: unknown
        owner?: string
    },
): Promise<Response> {
    return await fetch(`${server.origin}/api/plugin-storage/mutate`, {
        method: 'POST',
        headers: {
            ...auth,
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(valueRowKey(rawKey), 'utf-8').toString('hex'),
            'x-plugin-storage-operation': operation,
            'x-plugin-storage-generation': generation,
            'x-plugin-storage-owner': Buffer.from(owner, 'utf-8').toString('base64url'),
        },
        body: operation === 'set'
            ? Buffer.from(JSON.stringify(value), 'utf-8')
            : new Uint8Array(),
    })
}

async function clearActualPluginStorage(
    server: RunningServer,
    auth: AuthHeaders,
): Promise<Response> {
    return await fetch(`${server.origin}/api/plugin-storage/clear`, {
        method: 'POST',
        headers: auth,
    })
}

async function batchActualPluginStorage(
    server: RunningServer,
    auth: AuthHeaders,
    generation: string,
    expectedManifest: unknown,
    operations: unknown[],
): Promise<Response> {
    return await fetch(`${server.origin}/api/plugin-storage/batch`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        body: Buffer.from(JSON.stringify({
            version: 1,
            generation,
            expectedManifest,
            operations,
        })),
    })
}

async function mutateCurrentStorage(
    server: RunningServer,
    auth: AuthHeaders,
    changes: {
        writes?: Array<{ storageKey: string; value: unknown }>
        deletes?: string[]
    },
    failpoint?: string,
): Promise<Response> {
    const db = await decodeRisuSave(
        await readKey(server, auth, 'database/database.bin'),
    )
    const generation = db.pluginStorageGeneration as string
    const expectedManifest = JSON.parse(
        (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
    )
    const valueKeys = new Set<string>(expectedManifest.valueKeys)
    const metaKeys = new Set<string>(expectedManifest.metaKeys)
    const selectKeys = (storageKey: string) => (
        storageKey.startsWith(PLUGIN_SAVE_META_PREFIX) ? metaKeys : valueKeys
    )
    for (const write of changes.writes ?? []) selectKeys(write.storageKey).add(write.storageKey)
    for (const storageKey of changes.deletes ?? []) selectKeys(storageKey).delete(storageKey)
    return await mutateStorage(server, auth, {
        version: 1,
        generation,
        expectedManifest,
        nextManifest: {
            ...expectedManifest,
            valueKeys: [...valueKeys],
            metaKeys: [...metaKeys],
        },
        writes: (changes.writes ?? []).map(({ storageKey, value }) => ({
            storageKey,
            valueBytes: Buffer.from(JSON.stringify(value)),
        })),
        deletes: changes.deletes ?? [],
    }, failpoint)
}

async function readSnapshotDatabases(
    server: RunningServer,
    auth: AuthHeaders,
): Promise<Array<{ key: string; db: any }>> {
    const keys = await listSnapshotKeys(server, auth)
    return await Promise.all(keys.map(async (key) => ({
        key,
        db: await decodeRisuSave(await readKey(server, auth, key)),
    })))
}

afterEach(async () => {
    await Promise.all([...runningServers].map((server) => stopServer(server)))
    await Promise.all(tempDirs.splice(0).map(
        (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
    ))
})

describe('atomic plugin storage publication', () => {
    it('rolls an interrupted legacy adoption back to the legacy state', async () => {
        const cwd = makeWorkDir()
        let server = await startServer(cwd, {
            POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
        })
        let auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: true,
            pluginCustomStorage: {},
        }))
        // Simulate a row left by a pre-BR2 server. New generic writes are
        // rejected, but existing legacy rows still need atomic adoption.
        const legacyFixture = openFixtureDatabase(cwd)
        legacyFixture.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        ).run(
            valueRowKey('legacy'),
            Buffer.from(JSON.stringify({ durable: true })),
            Date.now(),
        )
        legacyFixture.close()
        const response = await transitionStorage(server, auth, {
            optimized: true,
            generation: null,
            manifest: null,
        }, encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: true,
            pluginStorageGeneration: crypto.randomUUID(),
            pluginCustomStorage: { legacy: { durable: true } },
        }), 'after-manifest')
        expect(response.status).toBe(500)
        expect(await response.text()).toContain('Injected plugin storage failure at after-manifest')

        await stopServer(server)
        server = await startServer(cwd, {
            POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
        })
        auth = await authenticate(server)
        const restartedDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        expect(restartedDb.pluginStorageGeneration).toBeUndefined()
        expect((await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).length).toBe(0)
        expect(JSON.parse(
            (await readKey(server, auth, valueRowKey('legacy'))).toString('utf-8'),
        )).toEqual({ durable: true })
    }, 30_000)

    it('publishes an existing-key update atomically for subsequent snapshots', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'old' },
        }))
        const db = await decodeRisuSave(await readKey(server, auth, 'database/database.bin'))
        const generation = db.pluginStorageGeneration as string
        const manifest = JSON.parse(
            (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
        )
        const oldSnapshotKey = (await listSnapshotKeys(server, auth))[0]
        const oldSnapshot = await decodeRisuSave(
            await readKey(server, auth, oldSnapshotKey),
        )
        expect(oldSnapshot.pluginCustomStorage?.alpha).toBe('old')
        const mutation = await mutateStorage(server, auth, {
            version: 1,
            generation,
            expectedManifest: manifest,
            nextManifest: manifest,
            writes: [{
                storageKey: valueRowKey('alpha'),
                valueBytes: Buffer.from(JSON.stringify('new')),
            }],
            deletes: [],
        })
        expect(mutation.status).toBe(200)
        expect(JSON.parse(
            (await readKey(server, auth, valueRowKey('alpha'))).toString('utf-8'),
        )).toBe('new')

        // A later ordinary database save is the snapshot trigger. The update
        // endpoint itself is deliberately outside BR1's trigger policy.
        await writeKey(
            server,
            auth,
            'database/database.bin',
            await readKey(server, auth, 'database/database.bin'),
        )
        const snapshotValues = await Promise.all(
            (await listSnapshotKeys(server, auth)).map(async (key) => {
                const snapshot = await decodeRisuSave(await readKey(server, auth, key))
                return snapshot.pluginCustomStorage?.alpha
            }),
        )
        expect(snapshotValues).toContain('new')
    }, 30_000)

    it.each(['after-row', 'after-manifest', 'after-database'])(
        'rolls back %s and remains entirely old after restart',
        async (failpoint) => {
            const cwd = makeWorkDir()
            let server = await startServer(cwd, {
                POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
            })
            let auth = await authenticate(server)
            await writeKey(server, auth, 'database/database.bin', buildDatabase({
                values: { alpha: 'old' },
            }))
            const oldDb = await decodeRisuSave(
                await readKey(server, auth, 'database/database.bin'),
            )
            const generation = oldDb.pluginStorageGeneration as string
            const manifest = JSON.parse(
                (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
            )
            const target = encodeRisuSaveLegacy({
                ...oldDb,
                optimizePluginMemory: false,
                pluginStorageGeneration: crypto.randomUUID(),
                pluginCustomStorage: { alpha: 'old' },
            })
            const response = await transitionStorage(server, auth, {
                optimized: true,
                generation,
                manifest,
            }, target, failpoint)
            expect(response.status).toBe(500)
            expect(await response.text()).toContain(`Injected plugin storage failure at ${failpoint}`)

            await stopServer(server)
            server = await startServer(cwd, {
                POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
            })
            auth = await authenticate(server)
            const restartedDb = await decodeRisuSave(
                await readKey(server, auth, 'database/database.bin'),
            )
            expect(restartedDb.optimizePluginMemory).toBe(true)
            expect(restartedDb.pluginStorageGeneration).toBe(generation)
            expect(JSON.parse(
                (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
            )).toEqual(manifest)
            expect(JSON.parse(
                (await readKey(server, auth, valueRowKey('alpha'))).toString('utf-8'),
            )).toBe('old')
        },
        30_000,
    )

    it('rejects generic writes, removes, and bulk writes to owned rows and the manifest', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)
        const ownedKey = valueRowKey('owned')
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { owned: 'authoritative' },
        }))
        const originalDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const generation = originalDb.pluginStorageGeneration as string
        const unlistedValueKey = valueRowKey('unlisted-value')
        const unlistedMetaKey = metaRowKey('unlisted-meta')
        const originalManifestBytes = await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)
        const originalRowBytes = await readKey(server, auth, ownedKey, generation)

        const attempts = [
            await writeKeyResponse(server, auth, ownedKey, Buffer.from(JSON.stringify('forged'))),
            await removeKeyResponse(server, auth, ownedKey),
            await bulkWriteResponse(server, auth, [
                { key: 'bulk/control', value: Buffer.from('must-not-land') },
                { key: ownedKey, value: Buffer.from(JSON.stringify('bulk-forged')) },
            ]),
            await writeKeyResponse(
                server,
                auth,
                PLUGIN_STORAGE_MANIFEST_KEY,
                manifestBytes('forged-generation', [], []),
            ),
            await removeKeyResponse(server, auth, PLUGIN_STORAGE_MANIFEST_KEY),
            await bulkWriteResponse(server, auth, [{
                key: PLUGIN_STORAGE_MANIFEST_KEY,
                value: manifestBytes('bulk-forged-generation', [], []),
            }]),
            await writeKeyResponse(
                server,
                auth,
                'database/database.bin',
                encodeRisuSaveLegacy({
                    ...originalDb,
                    pluginStorageGeneration: 'forged-database-generation',
                }),
            ),
            await removeKeyResponse(server, auth, 'database/database.bin'),
            await bulkWriteResponse(server, auth, [
                { key: 'bulk/database-control', value: Buffer.from('must-not-land') },
                {
                    key: 'database/database.bin',
                    value: encodeRisuSaveLegacy({
                        ...originalDb,
                        pluginStorageGeneration: 'bulk-forged-generation',
                    }),
                },
            ]),
            await writeKeyResponse(
                server,
                auth,
                unlistedValueKey,
                Buffer.from(JSON.stringify('must-not-land')),
            ),
            await removeKeyResponse(server, auth, unlistedMetaKey),
            await bulkWriteResponse(server, auth, [
                {
                    key: unlistedValueKey,
                    value: Buffer.from(JSON.stringify('bulk-value')),
                },
                {
                    key: unlistedMetaKey,
                    value: Buffer.from(JSON.stringify({ plugin: 'bulk-meta' })),
                },
            ]),
        ]
        for (const response of attempts) {
            expect(response.status).toBe(409)
        }

        expect(await readKey(server, auth, ownedKey, generation)).toEqual(originalRowBytes)
        expect(await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY))
            .toEqual(originalManifestBytes)
        expect((await readKey(server, auth, 'bulk/control')).length).toBe(0)
        expect((await readKey(server, auth, 'bulk/database-control')).length).toBe(0)
        expect((await readKey(server, auth, unlistedValueKey, generation)).length).toBe(0)
        expect((await readKey(server, auth, unlistedMetaKey, generation)).length).toBe(0)
        expect(await decodeRisuSave(await readKey(server, auth, 'database/database.bin')))
            .toEqual(originalDb)
    }, 30_000)

    it('rejects plugin publication patches before cache mutation, flush, and restart', async () => {
        const cwd = makeWorkDir()
        let server = await startServer(cwd)
        let auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { owned: 'authoritative' },
            meta: { owned: { plugin: 'Owner' } },
        }))
        const originalDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const generation = originalDb.pluginStorageGeneration as string
        const expectedHash = calculateHash(normalizeJSON(originalDb)).toString(16)
        const originalManifest = await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)
        const originalValue = await readKey(server, auth, valueRowKey('owned'), generation)
        const originalMeta = await readKey(server, auth, metaRowKey('owned'), generation)
        const attacks = [
            [{ op: 'replace', path: '/optimizePluginMemory', value: false }],
            [{ op: 'replace', path: '/pluginStorageGeneration', value: 'forged-generation' }],
            [{ op: 'add', path: '/pluginStorageFolded', value: true }],
            [{ op: 'replace', path: '/pluginCustomStorage', value: { forged: true } }],
            [{ op: 'replace', path: '/pluginStorageMeta', value: { forged: { plugin: 'Forged' } } }],
            [{ op: 'add', path: '/pluginStorageMeta/forged', value: { plugin: 'Forged' } }],
            [{ op: 'move', from: '/pluginCustomStorage', path: '/forgedMove' }],
            [{ op: 'copy', from: '/pluginStorageMeta', path: '/forgedCopy' }],
            [{
                op: 'replace',
                path: '',
                value: {
                    ...originalDb,
                    optimizePluginMemory: false,
                    pluginStorageGeneration: 'root-forged-generation',
                    pluginCustomStorage: { forged: 'root' },
                },
            }],
        ]
        for (const patch of attacks) {
            const response = await patchDatabaseResponse(
                server,
                auth,
                expectedHash,
                patch,
            )
            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({
                code: 'PLUGIN_STORAGE_PUBLICATION_GUARD',
            })
        }
        const directPatchTargets = [
            {
                key: valueRowKey('owned'),
                value: 'direct-value-forgery',
            },
            {
                key: metaRowKey('owned'),
                value: { plugin: 'Direct metadata forgery' },
            },
            {
                key: PLUGIN_STORAGE_MANIFEST_KEY,
                value: {
                    version: 1,
                    generation: 'direct-manifest-forgery',
                    valueKeys: [],
                    metaKeys: [],
                },
            },
        ]
        for (const { key, value } of directPatchTargets) {
            const directRowPatch = await fetch(`${server.origin}/api/patch`, {
                method: 'POST',
                headers: {
                    ...auth,
                    'content-type': 'application/json',
                    'file-path': Buffer.from(key).toString('hex'),
                },
                body: JSON.stringify({
                    expectedHash: 'guarded-before-hash',
                    patch: [{ op: 'replace', path: '', value }],
                }),
            })
            expect(directRowPatch.status).toBe(409)
            expect(await directRowPatch.json()).toMatchObject({
                code: 'PLUGIN_STORAGE_PUBLICATION_GUARD',
            })
        }

        const assertUnchanged = async () => {
            expect(await decodeRisuSave(await readKey(
                server,
                auth,
                'database/database.bin',
            ))).toEqual(originalDb)
            expect(await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY))
                .toEqual(originalManifest)
            expect(await readKey(server, auth, valueRowKey('owned'), generation))
                .toEqual(originalValue)
            expect(await readKey(server, auth, metaRowKey('owned'), generation))
                .toEqual(originalMeta)
        }
        await assertUnchanged()
        await flushDatabase(server, auth)
        await assertUnchanged()

        await stopServer(server)
        server = await startServer(cwd)
        auth = await authenticate(server)
        await assertUnchanged()
    }, 30_000)

    it('rejects generic staging into the pre-generation legacy namespace', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)
        const legacyKey = valueRowKey('legacy-owned')
        expect((await writeKeyResponse(
            server,
            auth,
            legacyKey,
            Buffer.from(JSON.stringify('missing-database-forgery')),
        )).status).toBe(409)
        await writeKey(server, auth, 'database/database.bin', encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: false,
            pluginCustomStorage: {},
        }))
        expect((await writeKeyResponse(
            server,
            auth,
            legacyKey,
            Buffer.from(JSON.stringify('disabled-forgery')),
        )).status).toBe(409)
        await writeKey(server, auth, 'database/database.bin', encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: true,
            pluginCustomStorage: {},
        }))
        const snapshotsBeforeRejectedStaging = await listSnapshotKeys(server, auth)

        expect((await writeKeyResponse(
            server,
            auth,
            legacyKey,
            Buffer.from(JSON.stringify('must-not-stage')),
        )).status).toBe(409)
        expect((await removeKeyResponse(server, auth, legacyKey)).status).toBe(409)
        expect((await bulkWriteResponse(server, auth, [{
            key: legacyKey,
            value: Buffer.from(JSON.stringify('bulk-must-not-stage')),
        }])).status).toBe(409)
        expect((await readKey(server, auth, legacyKey)).length).toBe(0)
        expect((await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).length).toBe(0)
        await delay(150)
        expect(await listSnapshotKeys(server, auth)).toEqual(snapshotsBeforeRejectedStaging)
    }, 30_000)

    it.each(['after-row', 'after-manifest'])(
        'rolls a mutate %s failure back without changing the persisted publication',
        async (failpoint) => {
            const cwd = makeWorkDir()
            let server = await startServer(cwd, {
                POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
            })
            let auth = await authenticate(server)
            await writeKey(server, auth, 'database/database.bin', buildDatabase({
                values: { alpha: 'old' },
            }))
            const originalDb = await decodeRisuSave(
                await readKey(server, auth, 'database/database.bin'),
            )
            const generation = originalDb.pluginStorageGeneration as string
            const originalManifest = JSON.parse(
                (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
            )
            const betaKey = valueRowKey('beta')
            const response = await mutateStorage(server, auth, {
                version: 1,
                generation,
                expectedManifest: originalManifest,
                nextManifest: {
                    ...originalManifest,
                    valueKeys: [...originalManifest.valueKeys, betaKey],
                },
                writes: [{ storageKey: betaKey, valueBytes: Buffer.from(JSON.stringify('new')) }],
                deletes: [],
            }, failpoint)
            expect(response.status).toBe(500)
            expect(await response.text()).toContain(
                `Injected plugin storage failure at ${failpoint}`,
            )

            await stopServer(server)
            server = await startServer(cwd, {
                POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
            })
            auth = await authenticate(server)
            expect(await decodeRisuSave(await readKey(
                server,
                auth,
                'database/database.bin',
            ))).toEqual(originalDb)
            expect(JSON.parse((await readKey(
                server,
                auth,
                PLUGIN_STORAGE_MANIFEST_KEY,
            )).toString('utf-8'))).toEqual(originalManifest)
            expect(JSON.parse((await readKey(
                server,
                auth,
                valueRowKey('alpha'),
                generation,
            )).toString('utf-8'))).toBe('old')
            expect((await readKey(server, auth, betaKey, generation)).length).toBe(0)
        },
        30_000,
    )

    it.each([
        ['generation', (generation: string, manifest: any) => ({
            generation: `${generation}-stale`,
            expectedManifest: manifest,
            nextManifest: manifest,
        })],
        ['manifest', (generation: string, manifest: any) => ({
            generation,
            expectedManifest: { ...manifest, valueKeys: [] },
            nextManifest: { ...manifest, valueKeys: [] },
        })],
    ] as const)(
        'returns 409 for a stale %s CAS and leaves persisted state unchanged',
        async (_kind, stalePlan) => {
            const server = await startServer(makeWorkDir())
            const auth = await authenticate(server)
            await writeKey(server, auth, 'database/database.bin', buildDatabase({
                values: { alpha: 'old' },
            }))
            const originalDb = await decodeRisuSave(
                await readKey(server, auth, 'database/database.bin'),
            )
            const generation = originalDb.pluginStorageGeneration as string
            const originalManifestBytes = await readKey(
                server,
                auth,
                PLUGIN_STORAGE_MANIFEST_KEY,
            )
            const originalManifest = JSON.parse(originalManifestBytes.toString('utf-8'))
            const response = await mutateStorage(server, auth, {
                version: 1,
                ...stalePlan(generation, originalManifest),
                writes: [{
                    storageKey: valueRowKey('alpha'),
                    valueBytes: Buffer.from(JSON.stringify('must-not-land')),
                }],
                deletes: [],
            })
            expect(response.status).toBe(409)
            expect(JSON.parse((await readKey(
                server,
                auth,
                valueRowKey('alpha'),
                generation,
            )).toString('utf-8'))).toBe('old')
            expect(await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY))
                .toEqual(originalManifestBytes)
            expect(await decodeRisuSave(await readKey(
                server,
                auth,
                'database/database.bin',
            ))).toEqual(originalDb)
        },
        30_000,
    )

    it('rejects an old session read when a newer generation reuses the same key', async () => {
        const server = await startServer(makeWorkDir())
        const oldSession = await authenticate(server)
        await writeKey(server, oldSession, 'database/database.bin', buildDatabase({
            values: { shared: 'old-generation-body' },
        }))
        const oldDb = await decodeRisuSave(
            await readKey(server, oldSession, 'database/database.bin'),
        )
        const oldGeneration = oldDb.pluginStorageGeneration as string
        const oldManifest = JSON.parse(
            (await readKey(server, oldSession, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
        )
        expect(JSON.parse((await readKey(
            server,
            oldSession,
            valueRowKey('shared'),
            oldGeneration,
        )).toString('utf-8'))).toBe('old-generation-body')

        const newSession = await authenticate(server)
        const newGeneration = crypto.randomUUID()
        const transition = await transitionStorage(server, newSession, {
            optimized: true,
            generation: oldGeneration,
            manifest: oldManifest,
        }, encodeRisuSaveLegacy({
            ...oldDb,
            optimizePluginMemory: true,
            pluginStorageGeneration: newGeneration,
            pluginCustomStorage: { shared: 'new-generation-body' },
        }))
        expect(transition.status).toBe(200)

        const explicitOldRead = await readKeyResponse(
            server,
            oldSession,
            valueRowKey('shared'),
            oldGeneration,
        )
        expect(explicitOldRead.status).toBe(409)
        expect(await explicitOldRead.text()).not.toContain('new-generation-body')
        const pinnedOldRead = await readKeyResponse(
            server,
            oldSession,
            valueRowKey('shared'),
        )
        expect(pinnedOldRead.status).toBe(409)
        const explicitCurrentOverride = await readKeyResponse(
            server,
            oldSession,
            valueRowKey('shared'),
            newGeneration,
        )
        expect(explicitCurrentOverride.status).toBe(409)
        expect(await explicitCurrentOverride.text()).not.toContain('new-generation-body')
        expect(JSON.parse((await readKey(
            server,
            newSession,
            valueRowKey('shared'),
            newGeneration,
        )).toString('utf-8'))).toBe('new-generation-body')
    }, 30_000)
})

describe('plugin publication recovery snapshot scheduling', () => {
    it('snapshots and restores actual V3 set/remove requests with an exact manifest', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'old', removed: 'delete-me' },
            meta: {
                alpha: { plugin: 'owner-old' },
                removed: { plugin: 'owner-removed' },
            },
        }))
        const db = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const generation = db.pluginStorageGeneration as string

        const setResponse = await mutateActualPluginStorage(server, auth, {
            rawKey: 'alpha',
            operation: 'set',
            generation,
            value: { actual: 'set' },
            owner: 'Actual Plugin',
        })
        expect(setResponse.status).toBe(200)
        await expect(setResponse.json()).resolves.toMatchObject({
            outcome: 'committed',
            operation: 'set',
        })
        const removeResponse = await mutateActualPluginStorage(server, auth, {
            rawKey: 'removed',
            operation: 'remove',
            generation,
        })
        expect(removeResponse.status).toBe(200)
        await expect(removeResponse.json()).resolves.toMatchObject({
            outcome: 'committed',
            operation: 'remove',
        })

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const expectedManifest = {
            version: 1,
            generation,
            valueKeys: [valueRowKey('alpha')],
            metaKeys: [metaRowKey('alpha')],
        }
        expect(JSON.parse((await readKey(
            server,
            auth,
            PLUGIN_STORAGE_MANIFEST_KEY,
        )).toString('utf-8'))).toEqual(expectedManifest)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage).toEqual({ alpha: { actual: 'set' } })
        expect(latest.db.pluginStorageMeta?.alpha).toMatchObject({
            plugin: 'Actual Plugin',
        })

        await restoreSnapshot(server, auth, latest.key)
        expect(JSON.parse((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
            generation,
        )).toString('utf-8'))).toEqual({ actual: 'set' })
        expect((await readKey(
            server,
            auth,
            valueRowKey('removed'),
            generation,
        )).length).toBe(0)
        expect(JSON.parse((await readKey(
            server,
            auth,
            PLUGIN_STORAGE_MANIFEST_KEY,
        )).toString('utf-8'))).toEqual(expectedManifest)
    }, 30_000)

    it('snapshots an actual V3 commit even when its acknowledgement is lost', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
            POCKETRISU_TEST_PLUGIN_MUTATION_FAILPOINT: 'acknowledgement-loss',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'before-ack-loss' },
            meta: { alpha: { plugin: 'owner-before' } },
        }))
        const db = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        await expect(mutateActualPluginStorage(server, auth, {
            rawKey: 'alpha',
            operation: 'set',
            generation: db.pluginStorageGeneration,
            value: 'committed-without-ack',
            owner: 'Ack Loss Plugin',
        })).rejects.toThrow()

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage?.alpha).toBe('committed-without-ack')
        expect(latest.db.pluginStorageMeta?.alpha).toMatchObject({
            plugin: 'Ack Loss Plugin',
        })
        await restoreSnapshot(server, auth, latest.key)
        expect(JSON.parse((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
            db.pluginStorageGeneration,
        )).toString('utf-8'))).toBe('committed-without-ack')
    }, 30_000)

    it('snapshots an exact AA3 batch when its acknowledgement is lost', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
            POCKETRISU_TEST_PLUGIN_BATCH_FAILPOINT: 'acknowledgement-loss',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'before-batch', removed: 'delete-me' },
            meta: {
                alpha: { plugin: 'owner-before' },
                removed: { plugin: 'owner-removed' },
            },
        }))
        const db = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const generation = db.pluginStorageGeneration as string
        const expectedManifest = JSON.parse((await readKey(
            server,
            auth,
            PLUGIN_STORAGE_MANIFEST_KEY,
        )).toString('utf-8'))

        await expect(batchActualPluginStorage(
            server,
            auth,
            generation,
            expectedManifest,
            [{
                operation: 'set',
                key: 'alpha',
                value: Buffer.from(JSON.stringify('committed-batch')).toString('base64'),
                owner: 'Batch Plugin',
            }, {
                operation: 'remove',
                key: 'removed',
            }],
        )).rejects.toThrow()

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage).toEqual({ alpha: 'committed-batch' })
        expect(latest.db.pluginStorageMeta).toEqual({
            alpha: expect.objectContaining({ plugin: 'Batch Plugin' }),
        })
        await restoreSnapshot(server, auth, latest.key)
        expect(JSON.parse((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
            generation,
        )).toString('utf-8'))).toBe('committed-batch')
        expect((await readKey(
            server,
            auth,
            valueRowKey('removed'),
            generation,
        )).length).toBe(0)
    }, 30_000)

    it('does not snapshot a rolled-back actual V3 value/owner request', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
            POCKETRISU_TEST_PLUGIN_MUTATION_FAILPOINT: 'owner-write',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'old' },
            meta: { alpha: { plugin: 'owner-old' } },
        }))
        const db = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const manifestBefore = await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)
        const response = await mutateActualPluginStorage(server, auth, {
            rawKey: 'alpha',
            operation: 'set',
            generation: db.pluginStorageGeneration,
            value: 'must-roll-back',
            owner: 'Must Roll Back',
        })
        expect(response.status).toBe(500)
        await delay(450)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(1)
        expect(await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY))
            .toEqual(manifestBefore)
        expect(JSON.parse((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
            db.pluginStorageGeneration,
        )).toString('utf-8'))).toBe('old')
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBe(0)
    }, 30_000)

    it('publishes an actual clear as an empty manifest and restorable snapshot', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'a', beta: 'b' },
            meta: {
                alpha: { plugin: 'owner-a' },
                beta: { plugin: 'owner-b' },
            },
        }))
        const db = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const response = await clearActualPluginStorage(server, auth)
        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            commitOutcome: 'committed',
        })

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const emptyManifest = {
            version: 1,
            generation: db.pluginStorageGeneration,
            valueKeys: [],
            metaKeys: [],
        }
        expect(JSON.parse((await readKey(
            server,
            auth,
            PLUGIN_STORAGE_MANIFEST_KEY,
        )).toString('utf-8'))).toEqual(emptyManifest)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage).toEqual({})
        expect(latest.db.pluginStorageMeta).toBeUndefined()

        await restoreSnapshot(server, auth, latest.key)
        expect((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
            db.pluginStorageGeneration,
        )).length).toBe(0)
        expect(JSON.parse((await readKey(
            server,
            auth,
            PLUGIN_STORAGE_MANIFEST_KEY,
        )).toString('utf-8'))).toEqual(emptyManifest)
    }, 30_000)

    it('schedules clear before acknowledgement loss and never schedules a failed clear', async () => {
        const lostAckServer = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
            POCKETRISU_TEST_PLUGIN_CLEAR_FAILPOINT: 'response',
        })
        const lostAckAuth = await authenticate(lostAckServer)
        await writeKey(lostAckServer, lostAckAuth, 'database/database.bin', buildDatabase({
            values: { alpha: 'clear-without-ack' },
            meta: { alpha: { plugin: 'owner' } },
        }))
        await readKey(lostAckServer, lostAckAuth, 'database/database.bin')
        await expect(clearActualPluginStorage(lostAckServer, lostAckAuth)).rejects.toThrow()
        await waitFor(async () => (
            await listSnapshotKeys(lostAckServer, lostAckAuth)
        ).length === 2)
        const [lostAckSnapshot] = await readSnapshotDatabases(lostAckServer, lostAckAuth)
        expect(lostAckSnapshot.db.pluginCustomStorage).toEqual({})

        const failedServer = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
            POCKETRISU_TEST_PLUGIN_CLEAR_FAILPOINT: 'transaction',
        })
        const failedAuth = await authenticate(failedServer)
        await writeKey(failedServer, failedAuth, 'database/database.bin', buildDatabase({
            values: { alpha: 'must-remain' },
            meta: { alpha: { plugin: 'owner' } },
        }))
        const failedDb = await decodeRisuSave(
            await readKey(failedServer, failedAuth, 'database/database.bin'),
        )
        const manifestBefore = await readKey(
            failedServer,
            failedAuth,
            PLUGIN_STORAGE_MANIFEST_KEY,
        )
        const failedResponse = await clearActualPluginStorage(failedServer, failedAuth)
        expect(failedResponse.status).toBe(500)
        await delay(450)
        expect(await listSnapshotKeys(failedServer, failedAuth)).toHaveLength(1)
        expect(await readKey(failedServer, failedAuth, PLUGIN_STORAGE_MANIFEST_KEY))
            .toEqual(manifestBefore)
        expect(JSON.parse((await readKey(
            failedServer,
            failedAuth,
            valueRowKey('alpha'),
            failedDb.pluginStorageGeneration,
        )).toString('utf-8'))).toBe('must-remain')
        expect((await readKey(failedServer, failedAuth, pluginRecoveryDirtyKey)).length)
            .toBe(0)
    }, 60_000)

    it('coalesces plugin-only sets and removes into one exact restorable point', async () => {
        const cwd = makeWorkDir()
        let server = await startServer(cwd, {
            POCKETRISU_BACKUP_INTERVAL_MS: '250',
        })
        let auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'old', removed: 'delete-me' },
            meta: {
                alpha: { plugin: 'owner-a' },
                removed: { plugin: 'owner-r' },
            },
        }))
        expect(await listSnapshotKeys(server, auth)).toHaveLength(1)

        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'new' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-a2' } },
            ],
        })).status).toBe(200)
        expect((await mutateCurrentStorage(server, auth, {
            deletes: [valueRowKey('removed'), metaRowKey('removed')],
        })).status).toBe(200)
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('added'), value: { final: true } },
                { storageKey: metaRowKey('added'), value: { plugin: 'owner-added' } },
            ],
        })).status).toBe(200)

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        await delay(350)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(2)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage).toEqual({
            alpha: 'new',
            added: { final: true },
        })
        expect(latest.db.pluginStorageMeta).toEqual({
            alpha: { plugin: 'owner-a2' },
            added: { plugin: 'owner-added' },
        })

        await restoreSnapshot(server, auth, latest.key)
        await stopServer(server)
        server = await startServer(cwd, { POCKETRISU_BACKUP_INTERVAL_MS: '250' })
        auth = await authenticate(server)
        const restoredDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const restoredGeneration = restoredDb.pluginStorageGeneration as string
        expect(JSON.parse((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
            restoredGeneration,
        )).toString('utf-8'))).toBe('new')
        expect(JSON.parse((await readKey(
            server,
            auth,
            metaRowKey('added'),
            restoredGeneration,
        )).toString('utf-8'))).toEqual({ plugin: 'owner-added' })
        expect((await readKey(
            server,
            auth,
            valueRowKey('removed'),
            restoredGeneration,
        )).length).toBe(0)
    }, 30_000)

    it('creates a later consistent point for a plugin commit after a chat snapshot', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '250',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', encodeRisuSaveLegacy({
            characters: [{
                chaId: 'char-post-chat',
                name: 'Character',
                chats: [{
                    id: 'chat-post-chat',
                    name: 'Chat',
                    message: [{ role: 'user', data: 'before' }],
                }],
            }],
            optimizePluginMemory: true,
            pluginCustomStorage: { alpha: 'before-plugin' },
            pluginStorageMeta: { alpha: { plugin: 'owner' } },
        }))
        await delay(275)

        const chatResponse = await fetch(
            `${server.origin}/api/chat-content/char-post-chat/0`,
            {
                method: 'POST',
                headers: {
                    ...auth,
                    'content-type': 'application/octet-stream',
                    'x-chat-id': 'chat-post-chat',
                },
                body: encodeRisuSaveLegacy({
                    id: 'chat-post-chat',
                    name: 'Chat',
                    message: [{ role: 'assistant', data: 'after-chat' }],
                }),
            },
        )
        expect(chatResponse.status).toBe(200)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(2)
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'after-plugin' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-after' } },
            ],
        })).status).toBe(200)

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 3)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage?.alpha).toBe('after-plugin')
        expect(latest.db.pluginStorageMeta?.alpha).toEqual({ plugin: 'owner-after' })
        expect(latest.db.characters?.[0]?.chats?.[0]?.message).toEqual([
            { role: 'assistant', data: 'after-chat' },
        ])
    }, 30_000)

    it('does not schedule a point for a rolled-back plugin mutation', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '250',
            POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'old' },
        }))
        const response = await mutateCurrentStorage(server, auth, {
            writes: [{ storageKey: valueRowKey('alpha'), value: 'must-roll-back' }],
        }, 'after-manifest')
        expect(response.status).toBe(500)
        await delay(400)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(1)
        expect(JSON.parse((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
        )).toString('utf-8'))).toBe('old')
    }, 30_000)

    it('retains the dirty token across a one-shot snapshot publication failure and retries', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
            POCKETRISU_TEST_FAILPOINT: 'prefix:database/dbbackup-:2',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'before-failure' },
            meta: { alpha: { plugin: 'owner-before' } },
        }))
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'after-failure' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-after' } },
            ],
        })).status).toBe(200)

        await waitFor(async () => server.logs().includes(
            'Injected kvSet failure for database/dbbackup-',
        ))
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBeGreaterThan(0)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(1)

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage?.alpha).toBe('after-failure')
        expect(latest.db.pluginStorageMeta?.alpha).toEqual({ plugin: 'owner-after' })
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBe(0)
    }, 30_000)

    it('cannot clear T2 when T2 replaces T1 after T1 assembly but before publication', async () => {
        const cwd = makeWorkDir()
        const gateDir = path.join(cwd, 'plugin-snapshot-gate')
        const server = await startServer(cwd, {
            POCKETRISU_BACKUP_INTERVAL_MS: '500',
            POCKETRISU_PLUGIN_RECOVERY_SNAPSHOT_TEST_GATE_DIR: gateDir,
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'initial' },
            meta: { alpha: { plugin: 'owner-initial' } },
        }))
        await armSnapshotPublicationGate(gateDir)
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'T1' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-T1' } },
            ],
        })).status).toBe(200)
        await waitForSnapshotPublicationGate(gateDir)

        replacePluginPublicationOutsideServer(cwd, {
            rawKey: 'alpha',
            value: 'T2',
            meta: { plugin: 'owner-T2' },
            recoveryToken: 'token-T2',
        })
        await releaseSnapshotPublicationGate(gateDir)
        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)

        // T1's already-assembled spool publishes, but its captured token must
        // not acknowledge the newer T2 transaction.
        let [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage?.alpha).toBe('T1')
        expect(latest.db.pluginStorageMeta?.alpha).toEqual({ plugin: 'owner-T1' })
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).toString('utf-8'))
            .toBe('token-T2')

        await disarmSnapshotPublicationGate(gateDir)
        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 3)
        ;[latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage?.alpha).toBe('T2')
        expect(latest.db.pluginStorageMeta?.alpha).toEqual({ plugin: 'owner-T2' })
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBe(0)
    }, 30_000)

    it('serializes a concurrent logical mutation behind assembly and later snapshots its exact pair', async () => {
        const cwd = makeWorkDir()
        const gateDir = path.join(cwd, 'plugin-snapshot-gate')
        const server = await startServer(cwd, {
            POCKETRISU_BACKUP_INTERVAL_MS: '500',
            POCKETRISU_PLUGIN_RECOVERY_SNAPSHOT_TEST_GATE_DIR: gateDir,
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'initial' },
            meta: { alpha: { plugin: 'owner-initial' } },
        }))
        await armSnapshotPublicationGate(gateDir)
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'T1' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-T1' } },
            ],
        })).status).toBe(200)
        const liveDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const manifest = JSON.parse(
            (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
        )
        await waitForSnapshotPublicationGate(gateDir)

        let concurrentSettled = false
        const concurrentMutation = mutateStorage(server, auth, {
            version: 1,
            generation: liveDb.pluginStorageGeneration,
            expectedManifest: manifest,
            nextManifest: manifest,
            writes: [
                { storageKey: valueRowKey('alpha'), valueBytes: Buffer.from(JSON.stringify('T2')) },
                {
                    storageKey: metaRowKey('alpha'),
                    valueBytes: Buffer.from(JSON.stringify({ plugin: 'owner-T2' })),
                },
            ],
            deletes: [],
        }).finally(() => { concurrentSettled = true })
        await delay(100)
        expect(concurrentSettled).toBe(false)

        await releaseSnapshotPublicationGate(gateDir)
        expect((await concurrentMutation).status).toBe(200)
        await disarmSnapshotPublicationGate(gateDir)
        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 3)

        const snapshots = await readSnapshotDatabases(server, auth)
        expect(snapshots.map(({ db }) => [
            db.pluginCustomStorage?.alpha,
            db.pluginStorageMeta?.alpha?.plugin,
        ])).toEqual([
            ['T2', 'owner-T2'],
            ['T1', 'owner-T1'],
            ['initial', 'owner-initial'],
        ])
        expect(snapshots.every(({ db }) => (
            db.pluginStorageGeneration === liveDb.pluginStorageGeneration
            && db.pluginStorageFolded === true
        ))).toBe(true)
    }, 30_000)

    it('keeps a failed pending database patch ahead of plugin snapshot acknowledgement', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd, {
            POCKETRISU_BACKUP_INTERVAL_MS: '300',
            POCKETRISU_TEST_FAILPOINT: 'prefix:database/database.bin:2',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'before-flush' },
            meta: { alpha: { plugin: 'owner-before' } },
        }))
        const liveDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'after-flush' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-after' } },
            ],
        })).status).toBe(200)
        const patch = await patchDatabaseResponse(
            server,
            auth,
            calculateHash(normalizeJSON(liveDb)).toString(16),
            [{ op: 'replace', path: '/formatPadding', value: 'after-flush' }],
        )
        expect(patch.status).toBe(200)

        await waitFor(async () => server.logs().includes(
            'Injected kvSet failure for database/database.bin',
        ))
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBeGreaterThan(0)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(1)
        const fixtureBeforeRetry = openFixtureDatabase(cwd)
        const persistedBeforeRetry = fixtureBeforeRetry.prepare(
            'SELECT value FROM kv WHERE key = ?',
        ).get('database/database.bin') as { value: Buffer }
        fixtureBeforeRetry.close()
        expect((await decodeRisuSave(Buffer.from(persistedBeforeRetry.value))).formatPadding)
            .not.toBe('after-flush')

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.formatPadding).toBe('after-flush')
        expect(latest.db.pluginCustomStorage?.alpha).toBe('after-flush')
        expect(latest.db.pluginStorageMeta?.alpha).toEqual({ plugin: 'owner-after' })
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBe(0)
    }, 30_000)

    it('supersedes an invalidated malformed chat cache and completes plugin recovery', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '400',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', encodeRisuSaveLegacy({
            characters: [{
                chaId: 'stub-loss-char',
                name: 'Character',
                chats: [{
                    id: 'stub-loss-chat',
                    name: 'Authoritative chat',
                    message: [{ role: 'user', data: 'must-survive' }],
                }],
            }],
            optimizePluginMemory: true,
            pluginCustomStorage: { alpha: 'before-stub-loss' },
            pluginStorageMeta: { alpha: { plugin: 'owner-before' } },
        }))
        const liveDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'after-stub-loss' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-after' } },
            ],
        })).status).toBe(200)

        // Whole-chat replacement is intentionally allowed at the patch
        // boundary; the persist guard detects that this metadata-only object is
        // neither a stub nor a hydrated chat and invalidates the cache.
        const malformedPatch = await patchDatabaseResponse(
            server,
            auth,
            calculateHash(normalizeJSON(liveDb)).toString(16),
            [{
                op: 'replace',
                path: '/characters/0/chats/0',
                value: { id: 'stub-loss-chat', name: 'Malformed replacement' },
            }],
        )
        expect(malformedPatch.status).toBe(200)

        await waitFor(async () => server.logs().includes(
            'persist aborted: 1 chat(s) lost _stub flag',
        ))
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBeGreaterThan(0)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(1)

        // The retry observes no retained cache, reloads authoritative live DB,
        // and can therefore satisfy the plugin recovery obligation.
        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage?.alpha).toBe('after-stub-loss')
        expect(latest.db.pluginStorageMeta?.alpha).toEqual({ plugin: 'owner-after' })
        expect(latest.db.characters?.[0]?.chats?.[0]?.message).toEqual([
            { role: 'user', data: 'must-survive' },
        ])
        expect(latest.db.characters?.[0]?.chats?.[0]?.name).toBe('Authoritative chat')
        expect((await readKey(server, auth, pluginRecoveryDirtyKey)).length).toBe(0)
    }, 30_000)

    it('keeps a pending mutation behind a transition and snapshots only the final publication', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '250',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'old' },
            meta: { alpha: { plugin: 'owner-old' } },
        }))
        expect((await mutateCurrentStorage(server, auth, {
            writes: [
                { storageKey: valueRowKey('alpha'), value: 'new' },
                { storageKey: metaRowKey('alpha'), value: { plugin: 'owner-new' } },
            ],
        })).status).toBe(200)
        const sourceDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const sourceManifest = JSON.parse(
            (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
        )
        const disabledGeneration = crypto.randomUUID()
        const transition = await transitionStorage(server, auth, {
            optimized: true,
            generation: sourceDb.pluginStorageGeneration,
            manifest: sourceManifest,
        }, encodeRisuSaveLegacy({
            ...sourceDb,
            optimizePluginMemory: false,
            pluginStorageGeneration: disabledGeneration,
            pluginCustomStorage: { alpha: 'new' },
            pluginStorageMeta: { alpha: { plugin: 'owner-new' } },
        }))
        expect(transition.status).toBe(200)

        await waitFor(async () => (await listSnapshotKeys(server, auth)).length === 2)
        const snapshots = await readSnapshotDatabases(server, auth)
        expect(snapshots[0].db).toMatchObject({
            optimizePluginMemory: false,
            pluginStorageGeneration: disabledGeneration,
            pluginCustomStorage: { alpha: 'new' },
            pluginStorageMeta: { alpha: { plugin: 'owner-new' } },
        })
        expect(snapshots.some(({ db }) => (
            db.optimizePluginMemory === true
            && db.pluginCustomStorage?.alpha === 'new'
        ))).toBe(false)
    }, 30_000)

    it('waits for an active backup-import barrier before retrying the deferred point', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '250',
            RISU_STREAM_INGEST_MIN_BYTES: '1',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'before-import' },
        }))
        expect((await mutateCurrentStorage(server, auth, {
            writes: [{ storageKey: valueRowKey('alpha'), value: 'after-import' }],
        })).status).toBe(200)

        const backup = encodeBackup([{
            name: 'database.risudat',
            data: lateFailingDatabase(),
        }])
        let releaseUpload!: () => void
        const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                controller.enqueue(new Uint8Array(backup))
                await uploadGate
                controller.close()
            },
        })
        const importDone = fetch(`${server.origin}/api/backup/import`, {
            method: 'POST',
            headers: {
                ...auth,
                'content-type': 'application/x-risu-backup',
            },
            body,
            // @ts-expect-error -- Node requires duplex for streaming request bodies.
            duplex: 'half',
        })

        // The scheduler becomes eligible while the importer holds its raw
        // transaction, but must neither snapshot inside it nor retry-spin.
        await delay(500)
        expect(await listSnapshotKeys(server, auth)).toHaveLength(1)
        releaseUpload()
        const importResponse = await importDone
        await importResponse.text()
        expect(importResponse.ok).toBe(false)

        await waitFor(async () => {
            const snapshots = await readSnapshotDatabases(server, auth)
            return snapshots.length === 2 && snapshots.some(({ db }) => (
                db.pluginCustomStorage?.alpha === 'after-import'
            ))
        })
    }, 30_000)

    it('defers through the snapshot-restore import barrier without resurrecting a newer row', async () => {
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '250',
        })
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'selected-old' },
        }))
        const [selectedSnapshot] = await listSnapshotKeys(server, auth)
        expect((await mutateCurrentStorage(server, auth, {
            writes: [{ storageKey: valueRowKey('alpha'), value: 'newer-live' }],
        })).status).toBe(200)
        await restoreSnapshot(server, auth, selectedSnapshot)

        await waitFor(async () => {
            const snapshots = await readSnapshotDatabases(server, auth)
            return snapshots.some(({ db }) => (
                db.pluginCustomStorage?.alpha === 'selected-old'
            )) && snapshots.length === 2
        })
        const [latest] = await readSnapshotDatabases(server, auth)
        expect(latest.db.pluginCustomStorage?.alpha).toBe('selected-old')
        expect((await readSnapshotDatabases(server, auth)).some(({ db }) => (
            db.pluginCustomStorage?.alpha === 'newer-live'
        ))).toBe(false)
    }, 30_000)

    it('resumes a cooldown-deferred plugin snapshot after process restart', async () => {
        const cwd = makeWorkDir()
        let server = await startServer(cwd, {
            POCKETRISU_BACKUP_INTERVAL_MS: '10000',
        })
        let auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { alpha: 'before-restart' },
        }))
        expect((await mutateCurrentStorage(server, auth, {
            writes: [{ storageKey: valueRowKey('alpha'), value: 'after-restart' }],
        })).status).toBe(200)
        await stopServer(server)

        server = await startServer(cwd, { POCKETRISU_BACKUP_INTERVAL_MS: '10000' })
        auth = await authenticate(server)
        await waitFor(async () => {
            const snapshots = await readSnapshotDatabases(server, auth)
            return snapshots.some(({ db }) => (
                db.pluginCustomStorage?.alpha === 'after-restart'
            ))
        })
        const [latest] = await readSnapshotDatabases(server, auth)
        await restoreSnapshot(server, auth, latest.key)
        const restoredDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        expect(JSON.parse((await readKey(
            server,
            auth,
            valueRowKey('alpha'),
            restoredDb.pluginStorageGeneration,
        )).toString('utf-8'))).toBe('after-restart')
    }, 30_000)
})

// The audit regression (docs/audit/snapshots-omit-optimized-plugin-storage.md):
// snapshot V1 → change to V2, delete an old key, add a new key → restore →
// the exact snapshot-time key set and values must come back.
async function runRoundTrip(options: { streamIngestMinBytes?: number }): Promise<void> {
    // This case explicitly restores the pre-mutation point. Keep the new BR1
    // deferred snapshot outside the test window so it cannot replace the same
    // 100 ms timestamp bucket before restore.
    const extraEnv = {
        POCKETRISU_BACKUP_INTERVAL_MS: '10000',
        ...(options.streamIngestMinBytes !== undefined
            ? { RISU_STREAM_INGEST_MIN_BYTES: String(options.streamIngestMinBytes) }
            : {}),
    }
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

    const liveBeforeMutation = await decodeRisuSave(
        await readKey(server, auth, 'database/database.bin'),
    )
    const generation = liveBeforeMutation.pluginStorageGeneration as string
    const manifest = JSON.parse(
        (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
    )
    const mutation = await mutateStorage(server, auth, {
        version: 1,
        generation,
        expectedManifest: manifest,
        nextManifest: {
            ...manifest,
            valueKeys: [valueRowKey('keyA'), valueRowKey('keyC')],
            metaKeys: [],
        },
        writes: [
            { storageKey: valueRowKey('keyA'), valueBytes: Buffer.from(JSON.stringify('V2')) },
            { storageKey: valueRowKey('keyC'), valueBytes: Buffer.from(JSON.stringify('added-later')) },
        ],
        deletes: [valueRowKey('keyB'), metaRowKey('keyA')],
    })
    expect(mutation.status).toBe(200)

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

    it('rejects malformed atomic plugin-row writes without replacing durable data', async () => {
        const server = await startServer(makeWorkDir())
        const auth = await authenticate(server)
        const key = valueRowKey('write-boundary')
        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { 'write-boundary': { durable: true } },
        }))
        const db = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )

        for (const invalid of [Buffer.from('{"unfinished":'), Buffer.from([0xff])]) {
            const response = await fetch(`${server.origin}/api/plugin-storage/mutate`, {
                method: 'POST',
                headers: {
                    ...auth,
                    'content-type': 'application/octet-stream',
                    'file-path': Buffer.from(key).toString('hex'),
                    'x-plugin-storage-operation': 'set',
                    'x-plugin-storage-generation': db.pluginStorageGeneration,
                    'x-plugin-storage-owner': '',
                },
                body: invalid,
            })
            expect(response.status).toBe(400)
            await expect(response.json()).resolves.toMatchObject({
                success: false,
                outcome: 'not-committed',
                error: expect.stringMatching(/valid UTF-8 JSON|Invalid plugin storage JSON row/),
                code: 'INVALID_PLUGIN_STORAGE_MUTATION',
            })
            expect(JSON.parse((await readKey(
                server,
                auth,
                key,
                db.pluginStorageGeneration,
            )).toString('utf-8')))
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
        const server = await startServer(makeWorkDir(), {
            POCKETRISU_BACKUP_INTERVAL_MS: '10000',
        })
        const auth = await authenticate(server)

        await writeKey(server, auth, 'database/database.bin', buildDatabase({ values: {} }))
        const snapshots = await listSnapshotKeys(server, auth)
        expect(snapshots.length).toBe(1)

        const legacyDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const adoption = await transitionStorage(server, auth, {
            optimized: true,
            generation: null,
            manifest: null,
        }, encodeRisuSaveLegacy({
            ...legacyDb,
            pluginStorageGeneration: crypto.randomUUID(),
            pluginCustomStorage: {},
        }))
        expect(adoption.status).toBe(200)

        expect((await mutateCurrentStorage(server, auth, {
            writes: [{
                storageKey: valueRowKey('keyX'),
                value: 'post-snapshot',
            }],
        })).status).toBe(200)
        await restoreSnapshot(server, auth, snapshots[0])

        expect((await readKey(server, auth, valueRowKey('keyX'))).length).toBe(0)
    })

    it('publishes disable and its snapshot boundary without a mixed external window', async () => {
        const cwd = makeWorkDir()
        const server = await startServer(cwd, { POCKETRISU_BACKUP_INTERVAL_MS: '0' })
        const auth = await authenticate(server)
        const valueKey = valueRowKey('window-key')

        await writeKey(server, auth, 'database/database.bin', buildDatabase({
            values: { 'window-key': 'snapshot-value' },
        }))
        const sourceDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const sourceGeneration = sourceDb.pluginStorageGeneration as string
        const sourceManifest = JSON.parse(
            (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
        )
        const disabledGeneration = crypto.randomUUID()
        const transition = await transitionStorage(server, auth, {
            optimized: true,
            generation: sourceGeneration,
            manifest: sourceManifest,
        }, encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: false,
            pluginStorageGeneration: disabledGeneration,
            pluginCustomStorage: { 'window-key': 'snapshot-value' },
        }))
        expect(transition.status).toBe(200)

        const disabledDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        expect(disabledDb.optimizePluginMemory).toBe(false)
        expect(disabledDb.pluginStorageGeneration).toBe(disabledGeneration)
        expect(disabledDb.pluginCustomStorage).toEqual({
            'window-key': 'snapshot-value',
        })
        expect((await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).length).toBe(0)

        const snapshots = await Promise.all(
            (await listSnapshotKeys(server, auth)).map(async key => (
                await decodeRisuSave(await readKey(server, auth, key))
            )),
        )
        expect(snapshots.some(snapshot => (
            snapshot.optimizePluginMemory === false
            && snapshot.pluginStorageGeneration === disabledGeneration
            && snapshot.pluginCustomStorage?.['window-key'] === 'snapshot-value'
        ))).toBe(true)

        await stopServer(server)
        const raw = openFixtureDatabase(cwd)
        expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(valueKey)).toBeUndefined()
        expect(raw.prepare('SELECT value FROM kv WHERE key = ?')
            .get(PLUGIN_STORAGE_MANIFEST_KEY)).toBeUndefined()
        raw.close()
    })

    it('folds an exact empty set when physical rows belong to another generation', async () => {
        const cwd = makeWorkDir()
        const foreignKey = valueRowKey('foreign')
        const selectedDatabase = Buffer.from(encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: true,
            pluginStorageGeneration: 'selected-generation',
            pluginCustomStorage: {},
            formatPadding: 'x'.repeat(4096),
        }))

        // Seed an inconsistent pre-fix publication directly; the generic API
        // must not be able to forge this mismatch anymore.
        const raw = openFixtureDatabase(cwd)
        const insert = raw.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        insert.run('database/database.bin', selectedDatabase, Date.now())
        insert.run(foreignKey, Buffer.from(JSON.stringify('foreign-value')), Date.now())
        insert.run(
            PLUGIN_STORAGE_MANIFEST_KEY,
            manifestBytes('foreign-generation', [foreignKey]),
            Date.now(),
        )
        raw.close()

        const server = await startServer(cwd)
        const auth = await authenticate(server)
        await writeKey(server, auth, 'database/database.bin', selectedDatabase)

        const [snapshotKey] = await listSnapshotKeys(server, auth)
        const snapshotDb = await decodeRisuSave(await readKey(server, auth, snapshotKey))
        expect(snapshotDb.pluginStorageFolded).toBe(true)
        expect(snapshotDb.pluginCustomStorage).toEqual({})

        await restoreSnapshot(server, auth, snapshotKey)
        expect((await readKey(server, auth, foreignKey)).length).toBe(0)
        expect(JSON.parse((await readKey(
            server,
            auth,
            PLUGIN_STORAGE_MANIFEST_KEY,
        )).toString('utf-8'))).toEqual({
            version: 1,
            generation: 'selected-generation',
            valueKeys: [],
            metaKeys: [],
        })
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

        const currentDb = await decodeRisuSave(
            await readKey(server, auth, 'database/database.bin'),
        )
        const generation = currentDb.pluginStorageGeneration as string
        const manifest = JSON.parse(
            (await readKey(server, auth, PLUGIN_STORAGE_MANIFEST_KEY)).toString('utf-8'),
        )
        const mutation = await mutateStorage(server, auth, {
            version: 1,
            generation,
            expectedManifest: manifest,
            nextManifest: manifest,
            writes: [{
                storageKey: valueRowKey('keyP'),
                valueBytes: Buffer.from(JSON.stringify('V2')),
            }],
            deletes: [],
        })
        expect(mutation.status).toBe(200)
        await restoreSnapshot(server, auth, stubKey)

        // Unmarked snapshots carry no plugin data to restore from; wiping the
        // physical row here would lose the only surviving copy. The restored
        // legacy DB no longer matches the newer manifest, so the public read
        // boundary correctly quarantines it; inspect the fixture directly.
        await stopServer(server)
        const afterRestore = openFixtureDatabase(cwd)
        const physical = afterRestore.prepare('SELECT value FROM kv WHERE key = ?')
            .get(valueRowKey('keyP')) as { value: Buffer }
        afterRestore.close()
        expect(JSON.parse(Buffer.from(physical.value).toString('utf-8'))).toBe('V2')
    })
})
