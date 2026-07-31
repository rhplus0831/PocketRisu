import { afterAll, describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function hexPath(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
}

async function writeKv(client: RisuClient, key: string, value: Buffer): Promise<void> {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': hexPath(key),
    },
    body: new Uint8Array(value),
  })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
}

async function readKv(client: RisuClient, key: string): Promise<Buffer | null> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': hexPath(key) },
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`read ${key} failed: ${response.status} ${await response.text()}`)
  }
  const value = Buffer.from(await response.arrayBuffer())
  return value.length === 0 ? null : value
}

async function createPartialBackup(client: RisuClient): Promise<Buffer> {
  const jobId = randomUUID()
  const create = await client.fetch('/api/backup/export/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'partial', jobId }),
  })
  expect(create.status).toBe(202)

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const statusResponse = await client.fetch(`/api/backup/export/jobs/${jobId}`)
    expect(statusResponse.status).toBe(200)
    const status = await statusResponse.json() as { state: string; error?: string }
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
  throw new Error('Timed out waiting for composer-draft partial backup')
}

function entryNames(backup: Buffer): string[] {
  return decodeBackup(backup).map(entry => entry.name)
}

describe('composer draft backup recovery', () => {
  test('Node full and partial backups round-trip referenced drafts only', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    expect((await sourceClient.importBackup(createSeedBackup({
      characterCount: 2,
      chatsPerCharacter: 2,
    }))).ok).toBe(true)

    const firstKey = 'drafts/test-char-0/chat-0-0'
    const secondKey = 'drafts/test-char-1/chat-1-1'
    const orphanKey = 'drafts/test-char-0/deleted-chat'
    const staleDestinationKey = 'drafts/stale-character/stale-chat'
    const firstValue = Buffer.from(JSON.stringify({ m: 'unfinished first message', t: '' }))
    const secondValue = Buffer.from(JSON.stringify({ m: '', t: '번역 중인 초안' }))
    await writeKv(sourceClient, firstKey, firstValue)
    await writeKv(sourceClient, secondKey, secondValue)
    await writeKv(sourceClient, orphanKey, Buffer.from(JSON.stringify({ m: 'orphan', t: '' })))

    const fullBackup = await sourceClient.exportBackup()
    const fullNames = entryNames(fullBackup)
    expect(fullNames).toContain(firstKey)
    expect(fullNames).toContain(secondKey)
    expect(fullNames).not.toContain(orphanKey)

    const partialBackup = await createPartialBackup(sourceClient)
    const partialNames = entryNames(partialBackup)
    expect(partialNames).toContain(firstKey)
    expect(partialNames).toContain(secondKey)
    expect(partialNames).not.toContain(orphanKey)

    const upstreamResponse = await sourceClient.fetch('/api/backup/export?target=upstream')
    expect(upstreamResponse.status).toBe(200)
    const upstreamNames = entryNames(Buffer.from(await upstreamResponse.arrayBuffer()))
    expect(upstreamNames.some(name => name.startsWith('drafts/'))).toBe(false)

    const destination = await spawnServer()
    servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(createSeedBackup())).ok).toBe(true)
    await writeKv(destinationClient, firstKey, Buffer.from(JSON.stringify({ m: 'stale', t: '' })))
    await writeKv(destinationClient, staleDestinationKey, Buffer.from(JSON.stringify({ m: 'remove me', t: '' })))

    expect((await destinationClient.importBackup(fullBackup)).ok).toBe(true)
    expect(await readKv(destinationClient, firstKey)).toEqual(firstValue)
    expect(await readKv(destinationClient, secondKey)).toEqual(secondValue)
    expect(await readKv(destinationClient, orphanKey)).toBeNull()
    expect(await readKv(destinationClient, staleDestinationKey)).toBeNull()

    const partialDestination = await spawnServer()
    servers.push(partialDestination)
    const partialDestinationClient = await createClient(
      partialDestination.port,
      partialDestination.password,
    )
    expect((await partialDestinationClient.importBackup(partialBackup)).ok).toBe(true)
    expect(await readKv(partialDestinationClient, firstKey)).toEqual(firstValue)
    expect(await readKv(partialDestinationClient, secondKey)).toEqual(secondValue)
  }, 120_000)

  test('save-folder import restores only drafts in its normalized chat graph', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

    const validKey = 'drafts/test-char-0/chat-0-0'
    const orphanKey = 'drafts/test-char-0/not-in-database'
    const staleKey = 'drafts/previous-character/previous-chat'
    const validValue = Buffer.from(JSON.stringify({ m: 'save-folder draft', t: 'translation' }))
    await writeKv(client, staleKey, Buffer.from(JSON.stringify({ m: 'stale', t: '' })))

    const database = decodeBackup(createSeedBackup())
      .find(entry => entry.name === 'database.risudat')!.data
    const saveFolder = Buffer.from(zipSync({
      [hexPath('database/database.bin')]: new Uint8Array(database),
      [hexPath(validKey)]: new Uint8Array(validValue),
      [hexPath(orphanKey)]: new Uint8Array(Buffer.from(JSON.stringify({ m: 'orphan', t: '' }))),
    }))

    const response = await client.fetch('/api/migrate/save-folder/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: new Uint8Array(saveFolder),
    })
    expect(response.status).toBe(200)
    await response.arrayBuffer()

    expect(await readKv(client, validKey)).toEqual(validValue)
    expect(await readKv(client, orphanKey)).toBeNull()
    expect(await readKv(client, staleKey)).toBeNull()
  }, 120_000)
})
