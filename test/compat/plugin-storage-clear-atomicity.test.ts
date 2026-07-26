import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import Database from 'better-sqlite3'
import path from 'node:path'
import utilsPkg from '../../server/node/utils.cjs'

const { encodeRisuSaveLegacy } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

const VALUE_KEYS = [
  'pluginsave/YWxwaGE.json',
  'pluginsave/YmV0YQ.json',
]
const OWNER_KEYS = [
  'pluginsave-meta/YWxwaGE.json',
  'pluginsave-meta/YmV0YQ.json',
]
const UNRELATED_KEY = 'drafts/clear-must-not-touch'
const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const STORAGE_GENERATION = 'clear-storage-generation'
const OLD_ROWS = new Map<string, Buffer>([
  [VALUE_KEYS[0], Buffer.from('{"value":"alpha"}')],
  [VALUE_KEYS[1], Buffer.from('{"value":"beta"}')],
  [OWNER_KEYS[0], Buffer.from('{"plugin":"A","updatedAt":1}')],
  [OWNER_KEYS[1], Buffer.from('{"plugin":"B","updatedAt":2}')],
])
const UNRELATED_VALUE = Buffer.from('{"retained":true}')
const ACTIVE_MANIFEST = {
  version: 1,
  generation: STORAGE_GENERATION,
  valueKeys: VALUE_KEYS,
  metaKeys: OWNER_KEYS,
}

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
  await response.text()
}

async function readKv(client: RisuClient, key: string): Promise<Buffer | null> {
  const headers: Record<string, string> = { 'file-path': hexPath(key) }
  if (key.startsWith('pluginsave/') || key.startsWith('pluginsave-meta/')) {
    headers['x-plugin-storage-generation'] = STORAGE_GENERATION
  }
  const response = await client.fetch('/api/read', {
    headers,
  })
  if (response.status === 404) return null
  if (response.status !== 200) {
    throw new Error(`read ${key} failed (${response.status}): ${await response.text()}`)
  }
  const value = Buffer.from(await response.arrayBuffer())
  return value.byteLength === 0 ? null : value
}

async function startSeededServer(failpoint = ''): Promise<{
  client: RisuClient
  server: ServerHandle
}> {
  const server = await spawnServer({
    env: failpoint
      ? { POCKETRISU_TEST_PLUGIN_CLEAR_FAILPOINT: failpoint }
      : undefined,
  })
  servers.push(server)
  const client = await createClient(server.port, server.password)
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
  try {
    const insert = sqlite.prepare(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    for (const [key, value] of OLD_ROWS) insert.run(key, value, Date.now())
    insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify(ACTIVE_MANIFEST)), Date.now())
    insert.run(DATABASE_KEY, Buffer.from(encodeRisuSaveLegacy({
      characters: [],
      optimizePluginMemory: true,
      pluginStorageGeneration: STORAGE_GENERATION,
      pluginCustomStorage: {},
    })), Date.now())
  } finally {
    sqlite.close()
  }
  await writeKv(client, UNRELATED_KEY, UNRELATED_VALUE)
  expect(await readKv(client, DATABASE_KEY)).not.toBeNull()
  return { client, server }
}

async function expectOldSet(client: RisuClient): Promise<void> {
  for (const [key, value] of OLD_ROWS) {
    expect(await readKv(client, key), key).toEqual(value)
  }
  expect(await readKv(client, UNRELATED_KEY)).toEqual(UNRELATED_VALUE)
  expect(JSON.parse((await readKv(client, MANIFEST_KEY))!.toString('utf-8')))
    .toEqual(ACTIVE_MANIFEST)
}

async function expectEmptyPluginSet(client: RisuClient): Promise<void> {
  for (const key of OLD_ROWS.keys()) {
    expect(await readKv(client, key), key).toBeNull()
  }
  expect(await readKv(client, UNRELATED_KEY)).toEqual(UNRELATED_VALUE)
  expect(JSON.parse((await readKv(client, MANIFEST_KEY))!.toString('utf-8')))
    .toEqual({
      version: 1,
      generation: STORAGE_GENERATION,
      valueKeys: [],
      metaKeys: [],
    })
}

describe('atomic optimized plugin storage clear', () => {
  test('commits the complete value + owner deletion in one request', async () => {
    const { client } = await startSeededServer()

    const response = await client.fetch('/api/plugin-storage/clear', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })
    await expectEmptyPluginSet(client)
  })

  test.each(['pre-transaction', 'transaction'])(
    '%s failure reports not-committed and preserves the complete old set',
    async (failpoint) => {
      const { client } = await startSeededServer(failpoint)

      const response = await client.fetch('/api/plugin-storage/clear', { method: 'POST' })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        code: 'PLUGIN_STORAGE_CLEAR_NOT_COMMITTED',
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
        retryable: true,
      })
      await expectOldSet(client)
    },
  )

  test('a response lost after commit leaves an honest unknown, retry-safe empty set', async () => {
    const { client } = await startSeededServer('response')

    await expect(client.fetch('/api/plugin-storage/clear', { method: 'POST' }))
      .rejects.toThrow()
    await expectEmptyPluginSet(client)

    // The caller may safely retry an unknown clear: it remains an all-or-none
    // transaction and clearing an already-empty fixed namespace is idempotent.
    await expect(client.fetch('/api/plugin-storage/clear', { method: 'POST' }))
      .rejects.toThrow()
    await expectEmptyPluginSet(client)
  })
})
