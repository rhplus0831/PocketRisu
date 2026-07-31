import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const MCP_PREFIX = 'cache/mcp-tool-calls/'
const MCP_SNAPSHOT_FIELD = '__pocketRisuMcpToolCallPayloadsV1'
const MCP_SNAPSHOT_MARKER = '__pocketRisuMcpToolCallsFoldedV1'
const DB_BLOB_KEY = 'database/database.bin'
const packr = new Packr({ useRecords: false })
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeRisuDat(value: Record<string, unknown>): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

function mcpStorageKey(callId: string): string {
  return `${MCP_PREFIX}${Buffer.from(callId, 'utf8').toString('base64url')}.json`
}

function payload(callId: string, name = 'lookup') {
  return {
    call: { id: callId, name, arg: { query: 'PocketRisu' } },
    response: [{ type: 'text', text: 'tool response retained' }],
  }
}

function recoverySeed(options: {
  callId: string
  includePayload?: boolean
  unreferencedId?: string
}): Buffer {
  const marker = `<tool_call>${options.callId}\uf100lookup</tool_call>`
  const database = encodeRisuDat({
    characters: [{
      chaId: 'mcp-character',
      name: 'MCP character',
      chats: [{
        id: 'mcp-chat',
        name: 'MCP chat',
        note: '',
        localLore: [],
        message: [
          { role: 'user', data: 'Use the lookup tool' },
          { role: 'char', data: `Done\n\n${marker}\n\n` },
        ],
      }],
    }],
    personas: [],
    botPresets: [],
    modules: [],
    selectedCharacter: 0,
  })
  const entries = [{ name: 'database.risudat', data: database }]
  if (options.includePayload !== false) {
    entries.push({
      name: mcpStorageKey(options.callId),
      data: Buffer.from(JSON.stringify(payload(options.callId)), 'utf8'),
    })
  }
  if (options.unreferencedId) {
    entries.push({
      name: mcpStorageKey(options.unreferencedId),
      data: Buffer.from(JSON.stringify(payload(options.unreferencedId, 'orphan')), 'utf8'),
    })
  }
  return encodeBackup(entries)
}

function readKvValue(cwd: string, key: string): Buffer | null {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = database.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: Buffer }
      | undefined
    return row ? Buffer.from(row.value) : null
  } finally {
    database.close()
  }
}

async function writeKv(client: RisuClient, key: string, value: Buffer): Promise<void> {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(key, 'utf8').toString('hex'),
    },
    body: new Uint8Array(value),
  })
  expect(response.status).toBe(200)
}

async function listSnapshots(client: RisuClient): Promise<Array<{ key: string }>> {
  const response = await client.fetch('/api/db/snapshots')
  expect(response.status).toBe(200)
  return ((await response.json()) as { snapshots: Array<{ key: string }> }).snapshots
}

async function waitForNewSnapshot(
  client: RisuClient,
  previousKeys: Set<string>,
): Promise<{ key: string }> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const snapshots = await listSnapshots(client)
    const created = snapshots.find(snapshot => !previousKeys.has(snapshot.key))
    if (created) return created
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for an MCP recovery snapshot')
}

async function createPartialBackup(client: RisuClient): Promise<Buffer> {
  const jobId = randomUUID()
  const create = await client.fetch('/api/backup/export/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'partial', jobId }),
  })
  expect(create.status).toBe(202)
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const response = await client.fetch(`/api/backup/export/jobs/${jobId}`)
    expect(response.status).toBe(200)
    const status = await response.json() as { state: string; error?: string }
    if (status.state === 'ready') {
      const download = await client.fetch(`/api/backup/export/jobs/${jobId}/download`)
      expect(download.status).toBe(200)
      return Buffer.from(await download.arrayBuffer())
    }
    if (status.state === 'failed' || status.state === 'cancelled') {
      throw new Error(status.error ?? `Partial backup ${status.state}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for the partial MCP recovery backup')
}

describe('remembered MCP tool-call recovery', () => {
  test('portable backup restores the referenced payload on a fresh server', async () => {
    const callId = 'call-portable-1'
    const unreferencedId = 'call-orphan-1'
    const staleId = 'call-stale-destination'
    const source = await spawnServer()
    const destination = await spawnServer()
    servers.push(source, destination)
    const sourceClient = await createClient(source.port, source.password)
    const destinationClient = await createClient(destination.port, destination.password)

    expect((await sourceClient.importBackup(recoverySeed({ callId, unreferencedId }))).ok).toBe(true)
    const exported = await sourceClient.exportBackup()
    const entries = new Map(decodeBackup(exported).map(entry => [entry.name, entry.data]))
    expect(JSON.parse(entries.get(mcpStorageKey(callId))!.toString('utf8'))).toEqual(payload(callId))
    expect(entries.has(mcpStorageKey(unreferencedId))).toBe(false)

    const serverSave = await sourceClient.fetch('/api/backup/server/save', { method: 'POST' })
    expect(serverSave.status).toBe(200)
    const saveEvents = (await serverSave.text()).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line))
    const saved = saveEvents.find(event => event.type === 'done') as { filename: string } | undefined
    expect(saved).toBeTruthy()
    const savedDownload = await sourceClient.fetch(`/api/backup/server/download/${saved!.filename}`)
    expect(savedDownload.status).toBe(200)
    const savedEntries = new Map(
      decodeBackup(Buffer.from(await savedDownload.arrayBuffer())).map(entry => [entry.name, entry.data]),
    )
    expect(JSON.parse(savedEntries.get(mcpStorageKey(callId))!.toString('utf8'))).toEqual(payload(callId))
    expect(savedEntries.has(mcpStorageKey(unreferencedId))).toBe(false)

    const partialEntries = new Map(
      decodeBackup(await createPartialBackup(sourceClient)).map(entry => [entry.name, entry.data]),
    )
    expect(JSON.parse(partialEntries.get(mcpStorageKey(callId))!.toString('utf8'))).toEqual(payload(callId))
    expect(partialEntries.has(mcpStorageKey(unreferencedId))).toBe(false)

    const upstream = decodeBackup(Buffer.from(await (
      await sourceClient.fetch('/api/backup/export?target=upstream')
    ).arrayBuffer()))
    expect(upstream.some(entry => entry.name.startsWith(MCP_PREFIX))).toBe(false)

    const mainResponse = await sourceClient.fetch('/api/backup/export?target=main')
    expect(mainResponse.status).toBe(200)
    const main = decodeBackup(Buffer.from(await mainResponse.arrayBuffer()))
    expect(main.some(entry => entry.name.startsWith(MCP_PREFIX))).toBe(false)

    await writeKv(
      destinationClient,
      mcpStorageKey(staleId),
      Buffer.from(JSON.stringify(payload(staleId)), 'utf8'),
    )
    expect((await destinationClient.importBackup(exported)).ok).toBe(true)
    expect(readKvValue(destination.cwd, mcpStorageKey(staleId))).toBeNull()
    expect(JSON.parse(readKvValue(destination.cwd, mcpStorageKey(callId))!.toString('utf8')))
      .toEqual(payload(callId))

    const reexported = new Map(
      decodeBackup(await destinationClient.exportBackup()).map(entry => [entry.name, entry.data]),
    )
    expect(JSON.parse(reexported.get(mcpStorageKey(callId))!.toString('utf8')))
      .toEqual(payload(callId))
  })

  test('strict full export rejects a remembered marker whose payload row is missing', async () => {
    const callId = 'call-missing-1'
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect((await client.importBackup(recoverySeed({ callId, includePayload: false }))).ok).toBe(true)
    const response = await client.fetch('/api/backup/export')
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      code: 'BACKUP_MISSING_MCP_TOOL_CALL_ROW',
      error: expect.stringContaining(callId),
    })
  })

  test('automatic snapshot folds and atomically restores referenced payloads', async () => {
    const callId = 'call-snapshot-1'
    const unreferencedId = 'call-snapshot-orphan'
    const staleId = 'call-snapshot-stale'
    const server = await spawnServer({
      env: { POCKETRISU_BACKUP_INTERVAL_MS: '0' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(recoverySeed({ callId, unreferencedId }))).ok).toBe(true)

    const before = new Set((await listSnapshots(client)).map(snapshot => snapshot.key))
    await new Promise(resolve => setTimeout(resolve, 125))
    await writeKv(client, DB_BLOB_KEY, readKvValue(server.cwd, DB_BLOB_KEY)!)
    const snapshot = await waitForNewSnapshot(client, before)
    const snapshotDatabase = decodeRisuDat(readKvValue(server.cwd, snapshot.key)!) as Record<string, any>
    const folded = snapshotDatabase[MCP_SNAPSHOT_FIELD] as Record<string, unknown>
    expect(snapshotDatabase[MCP_SNAPSHOT_MARKER]).toBe(true)
    expect(folded[`${Buffer.from(callId).toString('base64url')}.json`]).toEqual(payload(callId))
    expect(folded[`${Buffer.from(unreferencedId).toString('base64url')}.json`]).toBeUndefined()

    await writeKv(
      client,
      mcpStorageKey(callId),
      Buffer.from(JSON.stringify(payload(callId, 'corrupted-live-value')), 'utf8'),
    )
    await writeKv(
      client,
      mcpStorageKey(staleId),
      Buffer.from(JSON.stringify(payload(staleId)), 'utf8'),
    )

    const restore = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: snapshot.key }),
    })
    expect(restore.status).toBe(200)
    expect(JSON.parse(readKvValue(server.cwd, mcpStorageKey(callId))!.toString('utf8')))
      .toEqual(payload(callId))
    expect(readKvValue(server.cwd, mcpStorageKey(staleId))).toBeNull()

    const liveDatabase = decodeRisuDat(readKvValue(server.cwd, DB_BLOB_KEY)!)
    expect(liveDatabase).not.toHaveProperty(MCP_SNAPSHOT_FIELD)
    expect(liveDatabase).not.toHaveProperty(MCP_SNAPSHOT_MARKER)
  })
})
