import { afterAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import utilsPkg from '../../server/node/utils.cjs'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const { calculateHash, decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } = utilsPkg as {
  calculateHash: (value: unknown) => number
  decodeRisuSave: (value: Buffer) => Promise<any>
  encodeRisuSaveLegacy: (value: unknown, format?: string) => Uint8Array
  normalizeJSON: (value: unknown) => any
}
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')
const CHAT_DELTA_CONTENT_TYPE = 'application/vnd.pocketrisu.chat-delta+json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeRisuDat(value: Record<string, unknown>): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

function databaseValue(revision: string, characters: unknown[] = []): Record<string, unknown> {
  return {
    characters,
    apiType: 'openai',
    personas: [],
    botPresets: [],
    botPresetsId: 0,
    selectedCharacter: 0,
    snapshotSpoolRevision: revision,
  }
}

function encodeDatabase(revision: string, characters: unknown[] = []): Buffer {
  return encodeRisuDat(databaseValue(revision, characters))
}

function installBootMigrationSource(cwd: string, value: Buffer): void {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    const now = Date.now()
    database.prepare(`
      INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('database/database.bin', value, now)
    database.prepare("DELETE FROM kv WHERE key = 'migration/chats-externalized'").run()
  } finally {
    database.close()
  }
}

function spoolNamespacePath(spoolRoot: string, ownerId: string): string {
  const owner = createHash('sha256').update(ownerId.toLowerCase()).digest('hex')
  return path.join(spoolRoot, `.instance-${owner}`)
}

async function findSpoolFilesRecursively(
  root: string,
  prefix: string,
): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile() && entry.name.startsWith(prefix)) found.push(entryPath)
    }
  }
  await visit(root)
  return found
}

function writeDatabase(
  client: RisuClient,
  revision: string,
  characters: unknown[] = [],
): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': DB_BLOB_HEX,
    },
    body: new Uint8Array(encodeDatabase(revision, characters)),
  })
}

async function listSnapshots(client: RisuClient): Promise<Array<{ key: string }>> {
  const response = await client.fetch('/api/db/snapshots')
  expect(response.status).toBe(200)
  return ((await response.json()) as { snapshots: Array<{ key: string }> }).snapshots
}

async function readKv(client: RisuClient, key: string): Promise<Buffer | null> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': Buffer.from(key, 'utf8').toString('hex') },
  })
  if (response.status === 404) return null
  expect(response.status).toBe(200)
  return Buffer.from(await response.arrayBuffer())
}

async function readLatestSnapshot(client: RisuClient): Promise<any> {
  const [latest] = await listSnapshots(client)
  expect(latest).toBeTruthy()
  const bytes = await readKv(client, latest.key)
  expect(bytes).toBeTruthy()
  return decodeRisuSave(bytes!)
}

function writeKv(client: RisuClient, key: string, value: Buffer): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(key, 'utf8').toString('hex'),
    },
    body: new Uint8Array(value),
  })
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function waitForSnapshotCount(
  client: RisuClient,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await listSnapshots(client)).length === expectedCount) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${expectedCount} snapshot(s)`)
}

describe('database snapshot spool isolation', () => {
  test('chat saves acknowledge before automatic snapshot publication', async () => {
    const gateName = 'chat-snapshot-gate'
    const statsName = 'snapshot-stats.json'
    const server = await spawnServer({
      env: {
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
        POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
        POCKETRISU_TEST_SNAPSHOT_STATS_PATH: statsName,
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const chaId = 'snapshot-chat-character'
    const chatId = 'snapshot-chat'
    const character = {
      chaId,
      name: 'Snapshot chat character',
      chats: [{ id: chatId, name: 'Snapshot chat', _stub: true }],
    }

    expect((await writeDatabase(client, 'before-chat-save', [character])).status).toBe(200)
    await waitForSnapshotCount(client, 1)
    // Avoid coalescing with the completed full-write snapshot and ensure its
    // timestamp-derived key cannot collide with the chat snapshot key.
    await new Promise(resolve => setTimeout(resolve, 150))

    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')

    let chatSave: Promise<Response> | null = null
    let racingSave: Promise<Response> | null = null
    try {
      const chatBytes = encodeRisuDat({
        id: chatId,
        name: 'Snapshot chat',
        message: [{ role: 'user', data: 'committed before snapshot publication' }],
      })
      chatSave = client.fetch(`/api/chat-content/${chaId}/0`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-chat-id': chatId,
        },
        body: new Uint8Array(chatBytes),
      })

      // The gate is reached only after the row has committed and the deferred
      // full snapshot has been assembled. The HTTP acknowledgement must not be
      // waiting behind that publication boundary.
      await waitForFile(path.join(gateDir, 'entered'))
      const acknowledgement = await Promise.race([
        chatSave.then(response => ({ response })),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000)),
      ])
      expect(acknowledgement).not.toBeNull()
      if (!acknowledgement) throw new Error('Chat save remained blocked by snapshot publication')
      expect(acknowledgement.response.status).toBe(200)
      const acknowledgementBody = await acknowledgement.response.json() as {
        success: boolean
        hash: string
      }
      expect(acknowledgementBody).toMatchObject({
        success: true,
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })

      const stored = await client.fetch(`/api/chat-content/${chaId}/0`, {
        headers: { 'x-chat-id': chatId },
      })
      expect(stored.status).toBe(200)
      expect(stored.headers.get('x-content-hash')).toBe(acknowledgementBody.hash)
      expect(Buffer.from(await stored.arrayBuffer())).toEqual(chatBytes)

      const racingBytes = encodeRisuDat({
        id: chatId,
        name: 'Snapshot chat',
        message: [{ role: 'assistant', data: 'committed while pinned assembly waited' }],
      })
      racingSave = client.fetch(`/api/chat-content/${chaId}/0`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-chat-id': chatId,
        },
        body: new Uint8Array(racingBytes),
      })
      const raced = await Promise.race([
        racingSave,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000)),
      ])
      expect(raced).not.toBeNull()
      expect(raced?.status).toBe(200)
    } finally {
      await writeFile(path.join(gateDir, 'release'), '')
      await chatSave?.catch(() => {})
      await racingSave?.catch(() => {})
    }

    await waitForSnapshotCount(client, 2)
    const latest = await readLatestSnapshot(client)
    expect(latest.characters[0].chats[0].message).toEqual([
      { role: 'assistant', data: 'committed while pinned assembly waited' },
    ])
    const stats = JSON.parse(
      await readFile(path.join(server.cwd, statsName), 'utf8'),
    ) as Record<string, number>
    expect(stats).toMatchObject({
      metadataProbes: expect.any(Number),
      databaseBodySpools: expect.any(Number),
      tokenMismatches: expect.any(Number),
      publications: expect.any(Number),
    })
    expect(stats.metadataProbes).toBeGreaterThanOrEqual(3)
    expect(stats.databaseBodySpools).toBeGreaterThanOrEqual(3)
    expect(stats.tokenMismatches).toBeGreaterThanOrEqual(1)
    expect(stats.publications).toBe(2)
  })

  test('a delta append racing pinned assembly invalidates the older log view', async () => {
    const gateName = 'chat-delta-snapshot-gate'
    const statsName = 'chat-delta-snapshot-stats.json'
    const server = await spawnServer({
      env: {
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
        POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
        POCKETRISU_TEST_SNAPSHOT_STATS_PATH: statsName,
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const chaId = 'delta-snapshot-character'
    const chatId = 'delta-snapshot-chat'
    const character = {
      chaId,
      chats: [{ id: chatId, name: 'Delta snapshot chat', _stub: true }],
    }
    expect((await writeDatabase(client, 'delta-snapshot', [character])).status).toBe(200)
    await waitForSnapshotCount(client, 1)
    await new Promise(resolve => setTimeout(resolve, 150))

    const versions = [
      { id: chatId, name: 'Delta snapshot chat', message: [{ data: 'base' }] },
      { id: chatId, name: 'Delta snapshot chat', message: [{ data: 'first delta' }] },
      { id: chatId, name: 'Delta snapshot chat', message: [{ data: 'racing delta' }] },
    ]
    const bytes = versions.map(value => Buffer.from(encodeRisuSaveLegacy(value)))
    const hashes = bytes.map(value => createHash('sha256').update(value).digest('hex'))
    expect((await client.fetch(`/api/chat-content/${chaId}/0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-chat-id': chatId },
      body: new Uint8Array(bytes[0]),
    })).status).toBe(200)
    await waitForSnapshotCount(client, 2)
    await new Promise(resolve => setTimeout(resolve, 150))

    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    const postDelta = (index: 1 | 2) => client.fetch(`/api/chat-content/${chaId}/0`, {
      method: 'POST',
      headers: { 'content-type': CHAT_DELTA_CONTENT_TYPE, 'x-chat-id': chatId },
      body: JSON.stringify({
        version: 1,
        baseHash: hashes[index - 1],
        resultHash: hashes[index],
        resultSize: bytes[index].length,
        patch: [{ op: 'replace', path: '/message/0', value: versions[index].message[0] }],
      }),
    })

    try {
      expect((await postDelta(1)).status).toBe(200)
      await waitForFile(path.join(gateDir, 'entered'))
      const raced = await Promise.race([
        postDelta(2),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000)),
      ])
      expect(raced).not.toBeNull()
      expect(raced?.status).toBe(200)
    } finally {
      await writeFile(path.join(gateDir, 'release'), '')
    }

    await waitForSnapshotCount(client, 3)
    const latest = await readLatestSnapshot(client)
    expect(latest.characters[0].chats[0].message).toEqual([{ data: 'racing delta' }])
    const stats = JSON.parse(
      await readFile(path.join(server.cwd, statsName), 'utf8'),
    ) as Record<string, number>
    expect(stats.tokenMismatches).toBeGreaterThanOrEqual(1)
    expect(stats.publications).toBe(3)
  })

  test('explicit flush routes its pending-patch snapshot through pinned assembly', async () => {
    const gateName = 'flush-snapshot-gate'
    const server = await spawnServer({
      env: {
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
        POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const initial = databaseValue('before-flush')

    expect((await writeDatabase(client, 'before-flush')).status).toBe(200)
    await waitForSnapshotCount(client, 1)
    await new Promise(resolve => setTimeout(resolve, 150))

    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    const patched = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_BLOB_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(initial)).toString(16),
        patch: [{ op: 'add', path: '/flushedThroughPinnedSnapshot', value: true }],
      }),
    })
    expect(patched.status).toBe(200)

    const session = await client.fetch('/api/session', { method: 'POST' })
    expect(session.status).toBe(200)
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeTruthy()
    const flushed = await client.fetch('/api/db/flush', {
      method: 'POST',
      headers: { cookie: cookie! },
    })
    expect(flushed.status).toBe(200)

    await waitForFile(path.join(gateDir, 'entered'))
    let probe: Response | null = null
    try {
      probe = await Promise.race([
        writeKv(client, 'snapshot-test/flush-queue-probe', Buffer.from('committed')),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000)),
      ])
      expect(probe).not.toBeNull()
      expect(probe?.status).toBe(200)
    } finally {
      await writeFile(path.join(gateDir, 'release'), '')
    }

    await waitForSnapshotCount(client, 2)
    expect((await readLatestSnapshot(client)).flushedThroughPinnedSnapshot).toBe(true)
  })

  test('explicit flush retries a busy checkpoint until pinned assembly closes', async () => {
    const gateName = 'flush-checkpoint-retry-gate'
    const server = await spawnServer({
      env: {
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
        POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')

    expect((await writeDatabase(client, 'checkpoint-retry')).status).toBe(200)
    await waitForFile(path.join(gateDir, 'entered'))

    // Advance the WAL after the snapshot established its read mark so FULL
    // cannot complete until the assembly gate releases and closes that pin.
    expect((await writeKv(
      client,
      'snapshot-test/checkpoint-after-pin',
      Buffer.from('committed'),
    )).status).toBe(200)

    const session = await client.fetch('/api/session', { method: 'POST' })
    expect(session.status).toBe(200)
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeTruthy()

    let flushSettled = false
    const flushPromise = client.fetch('/api/db/flush', {
      method: 'POST',
      headers: { cookie: cookie! },
    }).finally(() => { flushSettled = true })
    let busyAttemptObserved = false
    const busyDeadline = Date.now() + 2_000
    try {
      while (Date.now() < busyDeadline) {
        const durability = await client.fetch('/api/db/durability')
        expect(durability.status).toBe(200)
        const state = await durability.json() as {
          lastCheckpoint?: { reason?: string; complete?: boolean }
        }
        if (state.lastCheckpoint?.reason === 'explicit-flush'
          && state.lastCheckpoint.complete === false) {
          busyAttemptObserved = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(flushSettled).toBe(false)
    } finally {
      await writeFile(path.join(gateDir, 'release'), '')
    }

    const flushed = await flushPromise
    expect(busyAttemptObserved).toBe(true)
    expect(flushed.status).toBe(200)
    await expect(flushed.json()).resolves.toMatchObject({
      success: true,
      durable: true,
      checkpoint: {
        mode: 'FULL',
        reason: 'explicit-flush',
        complete: true,
        busy: 0,
      },
    })
  })

  test('a destructive import during assembly invalidates the old spool before publication', async () => {
    const gateName = 'import-snapshot-gate'
    const statsName = 'import-snapshot-stats.json'
    const server = await spawnServer({
      env: {
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
        POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
        POCKETRISU_TEST_SNAPSHOT_STATS_PATH: statsName,
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect((await writeDatabase(client, 'before-import')).status).toBe(200)
    await waitForSnapshotCount(client, 1)
    await new Promise(resolve => setTimeout(resolve, 150))

    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    expect((await writeDatabase(client, 'must-never-publish')).status).toBe(200)
    await waitForFile(path.join(gateDir, 'entered'))

    const replacement = encodeBackup([
      { name: 'database.risudat', data: encodeDatabase('imported-winner') },
    ])
    const importDone = client.importBackup(replacement)
    let importBarrierObserved = false
    const barrierDeadline = Date.now() + 5_000
    for (let attempt = 0; Date.now() < barrierDeadline; attempt++) {
      const probe = await writeKv(
        client,
        `snapshot-test/import-probe-${attempt}`,
        Buffer.from('probe'),
      )
      await probe.text()
      if (probe.status === 503) {
        importBarrierObserved = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await writeFile(path.join(gateDir, 'release'), '')
    expect(importBarrierObserved).toBe(true)
    expect((await importDone).ok).toBe(true)

    await waitForSnapshotCount(client, 2)
    const snapshots = await listSnapshots(client)
    const decoded = await Promise.all(snapshots.map(async ({ key }) => {
      const bytes = await readKv(client, key)
      return decodeRisuSave(bytes!)
    }))
    expect(decoded.map(database => database.snapshotSpoolRevision)).toEqual([
      'imported-winner',
      'before-import',
    ])
    expect(decoded.some(database => (
      database.snapshotSpoolRevision === 'must-never-publish'
    ))).toBe(false)
    const stats = JSON.parse(
      await readFile(path.join(server.cwd, statsName), 'utf8'),
    ) as Record<string, number>
    expect(stats.tokenMismatches).toBeGreaterThanOrEqual(1)
  })

  test('hub writes snapshot through save/.spool without a backups directory', async () => {
    const instanceId = '70b9f079-0a1c-4a64-972d-8ef8a8934202'
    const spoolOwnerId = 'a680b3a2-6de0-4a84-912a-2ec5f38b4977'
    const orphanName = '.database-risudat-crash-orphan.tmp'
    const decodedOrphanName = '.risu-stream-load-123.decoded-crash.tmp'
    const legacyOrphanName = '.risu-legacy-load-123.decoded-crash.tmp'
    const blockOrphanName = '.risu-legacy-block-123.block-decoded-crash.tmp'
    const server = await spawnServer({
      createBackupsDir: false,
      env: {
        POCKETRISU_HUB_HOSTING: 'TRUE',
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
      },
      seedSave: async (saveDir) => {
        await writeFile(path.join(saveDir, '__instance_id'), instanceId, 'utf8')
        await writeFile(path.join(saveDir, '__spool_owner_id'), spoolOwnerId, 'utf8')
        const spoolDir = spoolNamespacePath(path.join(saveDir, '.spool'), spoolOwnerId)
        await mkdir(spoolDir, { recursive: true })
        await writeFile(path.join(spoolDir, orphanName), 'orphan')
        await writeFile(path.join(spoolDir, decodedOrphanName), 'decoded orphan')
        await writeFile(path.join(spoolDir, legacyOrphanName), 'legacy decoded orphan')
        await writeFile(path.join(spoolDir, blockOrphanName), 'block orphan')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const spoolDir = spoolNamespacePath(
      path.join(server.cwd, 'save', '.spool'),
      spoolOwnerId,
    )

    expect(existsSync(path.join(server.cwd, 'backups'))).toBe(false)
    expect(existsSync(path.join(server.cwd, 'save', '.spool'))).toBe(true)
    expect(existsSync(path.join(spoolDir, orphanName))).toBe(false)
    expect(existsSync(path.join(spoolDir, decodedOrphanName))).toBe(false)
    expect(existsSync(path.join(spoolDir, legacyOrphanName))).toBe(false)
    expect(existsSync(path.join(spoolDir, blockOrphanName))).toBe(false)

    expect((await writeDatabase(client, 'hub-write')).status).toBe(200)
    await waitForSnapshotCount(client, 1)
    expect(existsSync(path.join(server.cwd, 'backups'))).toBe(false)
  })

  test.each([
    ['default spool after inflation', 'decoded', {}],
    ['custom spool during traversal', 'traversal', {
      POCKETRISU_SPOOL_DIR: 'custom-stream-load-spool',
    }],
  ] as const)('restart sweeps a killed boot-migration decode in the %s', async (
    _case,
    phase,
    spoolEnv,
  ) => {
    const gateName = `stream-load-${phase}-gate`
    const server = await spawnServer({
      env: {
        ...spoolEnv,
        RISU_STREAM_INGEST_MIN_BYTES: '1',
        POCKETRISU_BACKUP_INTERVAL_MS: '3600000',
        POCKETRISU_STREAM_LOAD_TEST_GATE_DIR: gateName,
        POCKETRISU_STREAM_LOAD_TEST_GATE_PHASE: phase,
      },
    })
    servers.push(server)
    const source = Buffer.from(encodeRisuSaveLegacy({
      ...databaseValue(`boot-${phase}`, [{
        chaId: `boot-${phase}-character`,
        name: 'Boot migration character',
        chats: [{
          id: `boot-${phase}-chat`,
          name: 'Boot migration chat',
          message: [{ role: 'user', data: 'survives restart cleanup' }],
          note: '',
          localLore: [],
        }],
      }]),
      padding: 'decoded-spool-'.repeat(16 * 1024),
    }, 'compression'))

    await server.crash()
    installBootMigrationSource(server.cwd, source)
    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')

    const blockedBoot = server.restart().then(
      () => null,
      error => error,
    )
    await waitForFile(path.join(gateDir, 'entered'), 10_000)
    expect(await readFile(path.join(gateDir, 'entered'), 'utf8')).toBe(phase)
    const activeDecoded = await findSpoolFilesRecursively(
      server.spoolDir,
      '.risu-stream-load-',
    )
    expect(activeDecoded).toHaveLength(1)
    expect(path.dirname(activeDecoded[0])).toBe(server.spoolDir)
    expect((await readdir(path.join(server.cwd, 'save')))
      .some(name => name.startsWith('.risu-stream-load-'))).toBe(false)

    await server.crash()
    expect(await blockedBoot).toBeInstanceOf(Error)
    await writeFile(
      path.join(server.spoolDir, '.risu-legacy-load-crash.decoded-orphan.tmp'),
      'legacy orphan',
    )
    await writeFile(
      path.join(server.spoolDir, '.risu-legacy-block-crash.block-decoded-orphan.tmp'),
      'legacy block orphan',
    )
    await rm(path.join(gateDir, 'hold'))
    await rm(path.join(gateDir, 'entered'))
    await server.restart({ POCKETRISU_STREAM_LOAD_TEST_GATE_PHASE: '' })

    expect(await findSpoolFilesRecursively(server.spoolDir, '.risu-stream-load-')).toEqual([])
    expect(await findSpoolFilesRecursively(server.spoolDir, '.risu-legacy-load-')).toEqual([])
    expect(await findSpoolFilesRecursively(server.spoolDir, '.risu-legacy-block-')).toEqual([])
  })

  test('boot replaces an owned-child symlink without sweeping its outside victim', async () => {
    const victimDir = await mkdtemp(path.join(tmpdir(), 'risu-spool-symlink-victim-'))
    const victimSpool = path.join(victimDir, '.database-risudat-victim.tmp')
    const ownerId = 'c9ba6483-1a20-4078-aa74-dcde3c7e5764'
    await writeFile(victimSpool, 'must survive boot cleanup')
    try {
      const server = await spawnServer({
        env: { POCKETRISU_BACKUP_INTERVAL_MS: '0' },
        seedSave: async saveDir => {
          await writeFile(path.join(saveDir, '__spool_owner_id'), ownerId, 'utf8')
          const spoolRoot = path.join(saveDir, '.spool')
          await mkdir(spoolRoot)
          await symlink(victimDir, spoolNamespacePath(spoolRoot, ownerId), 'dir')
        },
      })
      servers.push(server)

      expect(await readFile(victimSpool, 'utf8')).toBe('must survive boot cleanup')
      const accepted = await lstat(server.spoolDir)
      expect(accepted.isDirectory()).toBe(true)
      expect(accepted.isSymbolicLink()).toBe(false)
      expect(accepted.mode & 0o777).toBe(0o700)
    } finally {
      await rm(victimDir, { recursive: true, force: true })
    }
  })

  test('runtime spooling stays pinned after the owned child is replaced by a symlink', async () => {
    const victimDir = await mkdtemp(path.join(tmpdir(), 'risu-runtime-spool-victim-'))
    const victimFile = path.join(victimDir, '.database-risudat-victim.tmp')
    const gateName = 'runtime-owned-path-swap-gate'
    await writeFile(victimFile, 'must survive runtime activity')
    try {
      const server = await spawnServer({
        env: {
          POCKETRISU_BACKUP_INTERVAL_MS: '0',
          POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
        },
      })
      servers.push(server)
      const parked = `${server.spoolDir}.runtime-parked`
      await rename(server.spoolDir, parked)
      await symlink(victimDir, server.spoolDir, 'dir')
      const gateDir = path.join(server.cwd, gateName)
      await mkdir(gateDir, { recursive: true })
      await writeFile(path.join(gateDir, 'hold'), '')
      const client = await createClient(server.port, server.password)

      expect((await writeDatabase(client, 'runtime-path-pinned')).status).toBe(200)
      await waitForFile(path.join(gateDir, 'entered'))
      expect((await findSpoolFilesRecursively(parked, '.database-risudat-')).length)
        .toBeGreaterThan(0)
      expect(await readdir(victimDir)).toEqual(['.database-risudat-victim.tmp'])
      expect(await readFile(victimFile, 'utf8')).toBe('must survive runtime activity')

      await writeFile(path.join(gateDir, 'release'), '')
      await waitForSnapshotCount(client, 1)
      expect((await readLatestSnapshot(client)).snapshotSpoolRevision)
        .toBe('runtime-path-pinned')
      expect(await readFile(victimFile, 'utf8')).toBe('must survive runtime activity')
    } finally {
      await rm(victimDir, { recursive: true, force: true })
    }
  })

  test('a first-boot clone claims away before touching an already-active source namespace', async () => {
    const sharedSpoolRoot = await mkdtemp(path.join(tmpdir(), 'risu-initial-clone-spool-'))
    const copiedAnalyticsId = '62c55932-913a-4387-aa64-e1273931aa82'
    const copiedOwnerId = '5472d9ad-51fd-499a-a59e-a77575925785'
    const gateName = 'initial-clone-snapshot-gate'
    let sourceServer: ServerHandle | null = null
    let cloneServer: ServerHandle | null = null
    try {
      sourceServer = await spawnServer({
        env: {
          POCKETRISU_SPOOL_DIR: sharedSpoolRoot,
          POCKETRISU_BACKUP_INTERVAL_MS: '0',
          POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
        },
        seedSave: async saveDir => {
          await writeFile(path.join(saveDir, '__instance_id'), copiedAnalyticsId)
          await writeFile(path.join(saveDir, '__spool_owner_id'), copiedOwnerId)
        },
      })
      const sourceClient = await createClient(sourceServer.port, sourceServer.password)
      const gateDir = path.join(sourceServer.cwd, gateName)
      await mkdir(gateDir, { recursive: true })
      await writeFile(path.join(gateDir, 'hold'), '')
      expect((await writeDatabase(sourceClient, 'initial-clone-source')).status).toBe(200)
      await waitForFile(path.join(gateDir, 'entered'))
      const sourceActive = await findSpoolFilesRecursively(
        sharedSpoolRoot,
        '.database-risudat-',
      )
      expect(sourceActive.length).toBeGreaterThan(0)

      cloneServer = await spawnServer({
        env: { POCKETRISU_SPOOL_DIR: sharedSpoolRoot },
        seedSave: async saveDir => {
          await writeFile(path.join(saveDir, '__instance_id'), copiedAnalyticsId)
          await writeFile(path.join(saveDir, '__spool_owner_id'), copiedOwnerId)
        },
      })
      const cloneOwner = (
        await readFile(path.join(cloneServer.cwd, 'save', '__spool_owner_id'), 'utf8')
      ).trim()
      expect(cloneOwner).toMatch(UUID_PATTERN)
      expect(cloneOwner).not.toBe(copiedOwnerId)
      expect(cloneServer.spoolDir).not.toBe(sourceServer.spoolDir)
      for (const activePath of sourceActive) expect(existsSync(activePath)).toBe(true)

      const cloneOrphan = path.join(
        cloneServer.spoolDir,
        '.database-risudat-clone-own-orphan.tmp',
      )
      await writeFile(cloneOrphan, 'clone orphan')
      await cloneServer.restart()
      expect(existsSync(cloneOrphan)).toBe(false)
      for (const activePath of sourceActive) expect(existsSync(activePath)).toBe(true)

      await writeFile(path.join(gateDir, 'release'), '')
      await waitForSnapshotCount(sourceClient, 1)
      expect((await readLatestSnapshot(sourceClient)).snapshotSpoolRevision)
        .toBe('initial-clone-source')
    } finally {
      if (sourceServer) await sourceServer.cleanup()
      if (cloneServer) await cloneServer.cleanup()
      await rm(sharedSpoolRoot, { recursive: true, force: true })
    }
  })

  test('concurrent copied-owner startups claim distinct namespaces without cross-cleanup', async () => {
    const sharedSpoolRoot = await mkdtemp(path.join(tmpdir(), 'risu-concurrent-clone-spool-'))
    const copiedOwnerId = '766b703f-9340-4626-bc5e-2c121d995af1'
    let first: ServerHandle | null = null
    let second: ServerHandle | null = null
    const options = {
      env: { POCKETRISU_SPOOL_DIR: sharedSpoolRoot },
      seedSave: async (saveDir: string) => {
        await writeFile(path.join(saveDir, '__spool_owner_id'), copiedOwnerId)
      },
    }
    try {
      ;[first, second] = await Promise.all([spawnServer(options), spawnServer(options)])
      const firstOwner = (
        await readFile(path.join(first.cwd, 'save', '__spool_owner_id'), 'utf8')
      ).trim()
      const secondOwner = (
        await readFile(path.join(second.cwd, 'save', '__spool_owner_id'), 'utf8')
      ).trim()
      expect(firstOwner).toMatch(UUID_PATTERN)
      expect(secondOwner).toMatch(UUID_PATTERN)
      expect(firstOwner).not.toBe(secondOwner)
      expect(first.spoolDir).not.toBe(second.spoolDir)
      expect(existsSync(`${first.spoolDir}.claim`)).toBe(true)
      expect(existsSync(`${second.spoolDir}.claim`)).toBe(true)

      const firstOrphan = path.join(first.spoolDir, '.database-risudat-first-orphan.tmp')
      const secondOrphan = path.join(second.spoolDir, '.database-risudat-second-orphan.tmp')
      await writeFile(firstOrphan, 'first orphan')
      await writeFile(secondOrphan, 'second orphan')
      await second.restart()
      expect(existsSync(firstOrphan)).toBe(true)
      expect(existsSync(secondOrphan)).toBe(false)
    } finally {
      if (first) await first.cleanup()
      if (second) await second.cleanup()
      await rm(sharedSpoolRoot, { recursive: true, force: true })
    }
  })

  test.each([
    ['copied analytics identity', '62c55932-913a-4387-aa64-e1273931aa82', null],
    [
      'copied valid analytics and owner identities',
      '62c55932-913a-4387-aa64-e1273931aa82',
      '5472d9ad-51fd-499a-a59e-a77575925785',
    ],
    ['copied corrupt identities', 'copied-invalid-analytics', 'copied-invalid-owner'],
  ])('restarting a peer with %s preserves an active snapshot', async (
    _identityCase,
    copiedInstanceId,
    copiedOwnerId,
  ) => {
    const sharedSpoolRoot = await mkdtemp(path.join(tmpdir(), 'risu-shared-spool-'))
    const gateName = 'shared-spool-snapshot-gate'
    let snapshotServer: ServerHandle | null = null
    let restartingServer: ServerHandle | null = null
    try {
      snapshotServer = await spawnServer({
        env: {
          POCKETRISU_SPOOL_DIR: sharedSpoolRoot,
          POCKETRISU_BACKUP_INTERVAL_MS: '0',
          POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR: gateName,
        },
        seedSave: async saveDir => {
          await writeFile(path.join(saveDir, '__instance_id'), copiedInstanceId, 'utf8')
          if (copiedOwnerId !== null) {
            await writeFile(path.join(saveDir, '__spool_owner_id'), copiedOwnerId, 'utf8')
          }
        },
      })
      restartingServer = await spawnServer({
        env: { POCKETRISU_SPOOL_DIR: sharedSpoolRoot },
        seedSave: async saveDir => {
          await writeFile(path.join(saveDir, '__instance_id'), copiedInstanceId, 'utf8')
          if (copiedOwnerId !== null) {
            await writeFile(path.join(saveDir, '__spool_owner_id'), copiedOwnerId, 'utf8')
          }
        },
      })
      const snapshotClient = await createClient(snapshotServer.port, snapshotServer.password)
      const snapshotInstanceId = (
        await readFile(path.join(snapshotServer.cwd, 'save', '__instance_id'), 'utf8')
      ).trim()
      const restartingInstanceId = (
        await readFile(path.join(restartingServer.cwd, 'save', '__instance_id'), 'utf8')
      ).trim()
      expect(snapshotInstanceId).toMatch(UUID_PATTERN)
      expect(restartingInstanceId).toMatch(UUID_PATTERN)
      if (UUID_PATTERN.test(copiedInstanceId)) {
        expect(snapshotInstanceId).toBe(copiedInstanceId)
        expect(restartingInstanceId).toBe(copiedInstanceId)
      } else {
        expect(snapshotInstanceId).not.toBe(copiedInstanceId)
        expect(restartingInstanceId).not.toBe(copiedInstanceId)
      }
      const snapshotOwnerId = await readFile(
        path.join(snapshotServer.cwd, 'save', '__spool_owner_id'),
        'utf8',
      ).then(value => value.trim(), () => null)
      const restartingOwnerId = await readFile(
        path.join(restartingServer.cwd, 'save', '__spool_owner_id'),
        'utf8',
      ).then(value => value.trim(), () => null)
      if (snapshotOwnerId !== null && restartingOwnerId !== null) {
        expect(snapshotOwnerId).toMatch(UUID_PATTERN)
        expect(restartingOwnerId).toMatch(UUID_PATTERN)
        expect(restartingOwnerId).not.toBe(snapshotOwnerId)
      }

      const restartingNamespace = restartingServer.spoolDir
      const gateDir = path.join(snapshotServer.cwd, gateName)
      await mkdir(gateDir, { recursive: true })
      await writeFile(path.join(gateDir, 'hold'), '')

      expect((await writeDatabase(snapshotClient, 'shared-spool-survivor')).status).toBe(200)
      await waitForFile(path.join(gateDir, 'entered'))
      const activePaths = await findSpoolFilesRecursively(
        sharedSpoolRoot,
        '.database-risudat-',
      )
      expect(activePaths.length).toBeGreaterThan(0)
      const peerOrphan = path.join(
        restartingNamespace,
        '.database-risudat-peer-crash-orphan.tmp',
      )
      const unownedLegacyOrphan = path.join(
        sharedSpoolRoot,
        '.database-risudat-unowned-legacy.tmp',
      )
      await mkdir(restartingNamespace, { recursive: true })
      await writeFile(peerOrphan, 'orphan')
      await writeFile(unownedLegacyOrphan, 'unowned')

      await restartingServer.restart()

      for (const activePath of activePaths) {
        expect(existsSync(activePath)).toBe(true)
      }
      expect(existsSync(peerOrphan)).toBe(false)
      expect(existsSync(unownedLegacyOrphan)).toBe(true)

      await writeFile(path.join(gateDir, 'release'), '')
      await waitForSnapshotCount(snapshotClient, 1)
      expect((await readLatestSnapshot(snapshotClient)).snapshotSpoolRevision)
        .toBe('shared-spool-survivor')
    } finally {
      if (snapshotServer) await snapshotServer.cleanup()
      if (restartingServer) await restartingServer.cleanup()
      await rm(sharedSpoolRoot, { recursive: true, force: true })
    }
  })

  test('failed spool does not fail writes or consume the snapshot cooldown', async () => {
    const spoolPath = path.join('save', 'blocked-spool')
    const server = await spawnServer({
      env: {
        POCKETRISU_SPOOL_DIR: spoolPath,
        POCKETRISU_BACKUP_INTERVAL_MS: '3600000',
        // This fixture intentionally makes the shared spool root unusable to
        // isolate non-fatal snapshot scheduling. Admitted-spool pressure is
        // covered separately by admitted-write-spool.test.ts.
        POCKETRISU_TEST_DISABLE_ADMITTED_SPOOL: '1',
      },
      seedSave: async (saveDir) => {
        await writeFile(path.join(saveDir, 'blocked-spool'), 'not a directory')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect((await writeDatabase(client, 'blocked')).status).toBe(200)
    expect(await listSnapshots(client)).toHaveLength(0)

    // The legacy manifest boundary is buffered rather than admitted-spooled.
    // It must still fail closed on the configured owned spool instead of
    // silently using the standalone loader's os.tmpdir() fallback.
    const processTempPrefix = `.risu-legacy-load-${server.pid}.`
    const osTempBefore = (await readdir(tmpdir()))
      .filter(name => name.startsWith(processTempPrefix))
    const compressedPlan = gzipSync(Buffer.from(packr.encode({
      version: 1,
      generation: 'blocked-spool-generation',
      expectedManifest: {
        version: 1,
        generation: 'blocked-spool-generation',
        valueKeys: [],
        metaKeys: [],
      },
      nextManifest: {
        version: 1,
        generation: 'blocked-spool-generation',
        valueKeys: [],
        metaKeys: [],
      },
      writes: [],
      deletes: [],
    })))
    const blockedManifest = await client.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(compressedPlan),
    })
    expect(blockedManifest.status).toBe(500)
    expect(await blockedManifest.text()).toContain('configured database spool is unavailable')
    expect((await readdir(tmpdir())).filter(name => name.startsWith(processTempPrefix)))
      .toEqual(osTempBefore)

    const failedExport = await client.fetch('/api/backup/export')
    expect(failedExport.status).toBe(500)

    const absoluteSpoolPath = path.join(server.cwd, spoolPath)
    await rm(absoluteSpoolPath)
    await mkdir(absoluteSpoolPath)

    expect((await writeDatabase(client, 'recovered')).status).toBe(200)
    await waitForSnapshotCount(client, 1)
  })

  test('admitted writes recover after a blocked custom spool root is repaired', async () => {
    const spoolPath = path.join('save', 'repairable-spool')
    const server = await spawnServer({
      env: {
        POCKETRISU_SPOOL_DIR: spoolPath,
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
      },
      seedSave: async saveDir => {
        await writeFile(path.join(saveDir, 'repairable-spool'), 'not a directory')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const unavailable = await writeDatabase(client, 'blocked-admitted-write')
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({
      code: 'BUFFERED_INGRESS_BUSY',
      retryable: true,
    })

    const absoluteSpoolPath = path.join(server.cwd, spoolPath)
    await rm(absoluteSpoolPath)
    await mkdir(absoluteSpoolPath)

    expect((await writeDatabase(client, 'repaired-admitted-write')).status).toBe(200)
    await waitForSnapshotCount(client, 1)
    expect(existsSync(server.spoolDir)).toBe(true)
  })

  test('spawn handle resolves an inherited custom spool root exactly like the child', async () => {
    const inheritedRoot = await mkdtemp(path.join(tmpdir(), 'risu-inherited-spool-'))
    const previous = process.env.POCKETRISU_SPOOL_DIR
    let server: ServerHandle | null = null
    try {
      process.env.POCKETRISU_SPOOL_DIR = inheritedRoot
      server = await spawnServer()
      expect(path.dirname(server.spoolDir)).toBe(inheritedRoot)
      expect(existsSync(server.spoolDir)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.POCKETRISU_SPOOL_DIR
      else process.env.POCKETRISU_SPOOL_DIR = previous
      if (server) await server.cleanup()
      await rm(inheritedRoot, { recursive: true, force: true })
    }
  })
})
