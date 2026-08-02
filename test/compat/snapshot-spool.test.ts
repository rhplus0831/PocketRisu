import { afterAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import utilsPkg from '../../server/node/utils.cjs'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const { calculateHash, decodeRisuSave, normalizeJSON } = utilsPkg as {
  calculateHash: (value: unknown) => number
  decodeRisuSave: (value: Buffer) => Promise<any>
  normalizeJSON: (value: unknown) => any
}
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')
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
    const orphanName = '.database-risudat-crash-orphan.tmp'
    const decodedOrphanName = `${orphanName}.decoded-crash.tmp`
    const blockOrphanName = `${orphanName}.block-decoded-crash.tmp`
    const server = await spawnServer({
      createBackupsDir: false,
      env: {
        POCKETRISU_HUB_HOSTING: 'TRUE',
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
      },
      seedSave: async (saveDir) => {
        const spoolDir = path.join(saveDir, '.spool')
        await mkdir(spoolDir, { recursive: true })
        await writeFile(path.join(spoolDir, orphanName), 'orphan')
        await writeFile(path.join(spoolDir, decodedOrphanName), 'decoded orphan')
        await writeFile(path.join(spoolDir, blockOrphanName), 'block orphan')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect(existsSync(path.join(server.cwd, 'backups'))).toBe(false)
    expect(existsSync(path.join(server.cwd, 'save', '.spool'))).toBe(true)
    expect(existsSync(path.join(server.cwd, 'save', '.spool', orphanName))).toBe(false)
    expect(existsSync(path.join(server.cwd, 'save', '.spool', decodedOrphanName))).toBe(false)
    expect(existsSync(path.join(server.cwd, 'save', '.spool', blockOrphanName))).toBe(false)

    expect((await writeDatabase(client, 'hub-write')).status).toBe(200)
    await waitForSnapshotCount(client, 1)
    expect(existsSync(path.join(server.cwd, 'backups'))).toBe(false)
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

    const failedExport = await client.fetch('/api/backup/export')
    expect(failedExport.status).toBe(500)

    const absoluteSpoolPath = path.join(server.cwd, spoolPath)
    await rm(absoluteSpoolPath)
    await mkdir(absoluteSpoolPath)

    expect((await writeDatabase(client, 'recovered')).status).toBe(200)
    await waitForSnapshotCount(client, 1)
  })
})
