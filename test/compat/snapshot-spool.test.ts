import { afterAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeRisuDat(value: Record<string, unknown>): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

function encodeDatabase(revision: string, characters: unknown[] = []): Buffer {
  return encodeRisuDat({
    characters,
    apiType: 'openai',
    personas: [],
    botPresets: [],
    botPresetsId: 0,
    selectedCharacter: 0,
    snapshotSpoolRevision: revision,
  })
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
    const server = await spawnServer({
      env: {
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
        POCKETRISU_PLUGIN_RECOVERY_SNAPSHOT_TEST_GATE_DIR: gateName,
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
    } finally {
      await writeFile(path.join(gateDir, 'release'), '')
      await chatSave?.catch(() => {})
    }

    await waitForSnapshotCount(client, 2)
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
    expect(await listSnapshots(client)).toHaveLength(1)
    expect(existsSync(path.join(server.cwd, 'backups'))).toBe(false)
  })

  test('failed spool does not fail writes or consume the snapshot cooldown', async () => {
    const spoolPath = path.join('save', 'blocked-spool')
    const server = await spawnServer({
      env: {
        POCKETRISU_SPOOL_DIR: spoolPath,
        POCKETRISU_BACKUP_INTERVAL_MS: '3600000',
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
    expect(await listSnapshots(client)).toHaveLength(1)
  })
})
