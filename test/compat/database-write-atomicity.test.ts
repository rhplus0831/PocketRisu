import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const require = createRequire(import.meta.url)
const { calculateHash, normalizeJSON } = require('../../server/node/utils.cjs') as {
  calculateHash: (value: unknown) => number
  normalizeJSON: (value: unknown) => Record<string, any>
}

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const DB_KEY = 'database/database.bin'
const DB_PATH_HEX = Buffer.from(DB_KEY, 'utf-8').toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeRisuDat(value: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

function pluginStorageKey(prefix: 'pluginsave/' | 'pluginsave-meta/', rawKey: string): string {
  return `${prefix}${Buffer.from(rawKey, 'utf-8').toString('base64url')}.json`
}

function chatRowKey(chaId: string, chatId: string): string {
  return `chats/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`
}

function makeFullDatabase(
  version: 'old' | 'new',
  includePluginStorage = true,
): Record<string, any> {
  const databaseEntry = decodeBackup(createSeedBackup({
    characterCount: 2,
    chatsPerCharacter: 2,
    messagesPerChat: 3,
  })).find(entry => entry.name === 'database.risudat')
  if (!databaseEntry) throw new Error('seed backup has no database.risudat')

  const database = decodeRisuDat(databaseEntry.data) as Record<string, any>
  for (const character of database.characters) {
    for (const chat of character.chats) {
      chat.name = `${version}-${chat.id}`
      chat.message = chat.message.map((message: Record<string, unknown>, index: number) => ({
        ...message,
        data: `${version} message ${index} for ${chat.id}`,
      }))
    }
  }
  database.optimizePluginMemory = true
  database.pluginCustomStorage = includePluginStorage
    ? {
        'shared/key': { version, nested: [version, 1] },
        [`${version}/only`]: { version },
      }
    : {}
  if (includePluginStorage) {
    database.pluginStorageMeta = {
      'shared/key': { plugin: `${version} plugin`, updatedAt: version === 'old' ? 1 : 2 },
    }
  }
  return database
}

function makeExternalizedSeed(): {
  strippedDb: Record<string, any>
  rows: Map<string, Buffer>
} {
  const fullDb = makeFullDatabase('old')
  const strippedDb = structuredClone(fullDb)
  const rows = new Map<string, Buffer>()

  for (const character of strippedDb.characters) {
    character.chats = character.chats.map((chat: Record<string, any>) => {
      rows.set(chatRowKey(character.chaId, chat.id), encodeRisuDat(chat))
      const stub: Record<string, unknown> = {
        id: chat.id,
        name: chat.name,
        _stub: true,
      }
      if ('lastDate' in chat) stub.lastDate = chat.lastDate
      if ('folderId' in chat) stub.folderId = chat.folderId
      if ('modules' in chat) stub.modules = chat.modules
      return stub
    })
  }

  for (const [rawKey, value] of Object.entries(strippedDb.pluginCustomStorage)) {
    rows.set(
      pluginStorageKey('pluginsave/', rawKey),
      Buffer.from(JSON.stringify(value), 'utf-8'),
    )
  }
  for (const [rawKey, value] of Object.entries(strippedDb.pluginStorageMeta)) {
    rows.set(
      pluginStorageKey('pluginsave-meta/', rawKey),
      Buffer.from(JSON.stringify(value), 'utf-8'),
    )
  }
  strippedDb.pluginCustomStorage = {}
  delete strippedDb.pluginStorageMeta
  rows.set(DB_KEY, encodeRisuDat(strippedDb))
  rows.set('migration/chats-externalized', Buffer.from('done'))
  rows.set('migration/disable-remote-saving', Buffer.from('done'))
  return { strippedDb, rows }
}

async function bootSeeded(failpoint?: string): Promise<{
  client: RisuClient
  server: ServerHandle
  strippedDb: Record<string, any>
}> {
  const seed = makeExternalizedSeed()
  const server = await spawnServer({
    env: failpoint ? { POCKETRISU_TEST_FAILPOINT: failpoint } : undefined,
    seedSave: async (saveDir) => {
      const database = new Database(path.join(saveDir, 'risuai.db'))
      try {
        database.exec(`
          CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        const insert = database.prepare(
          'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        for (const [key, value] of seed.rows) insert.run(key, value, Date.now())
      } finally {
        database.close()
      }
    },
  })
  servers.push(server)
  return {
    client: await createClient(server.port, server.password),
    server,
    strippedDb: seed.strippedDb,
  }
}

function snapshotExternalRows(cwd: string): Map<string, Buffer> {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const rows = database.prepare(`
      SELECT key, value FROM kv
      WHERE key = ?
         OR key LIKE 'chats/%'
         OR key LIKE 'pluginsave/%'
         OR key LIKE 'pluginsave-meta/%'
      ORDER BY key
    `).all(DB_KEY) as Array<{ key: string; value: Buffer }>
    return new Map(rows.map(row => [row.key, Buffer.from(row.value)]))
  } finally {
    database.close()
  }
}

function readKv(cwd: string, key: string): Buffer | null {
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

async function writeFullDatabase(client: RisuClient, database: Record<string, any>): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': DB_PATH_HEX,
    },
    body: new Uint8Array(encodeRisuDat(database)),
  })
}

async function removeSecondChat(
  client: RisuClient,
  strippedDb: Record<string, any>,
): Promise<Response> {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'file-path': DB_PATH_HEX,
    },
    body: JSON.stringify({
      expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
      patch: [{ op: 'remove', path: '/characters/0/chats/1' }],
    }),
  })
}

async function flushDatabase(client: RisuClient): Promise<Response> {
  const sessionResponse = await client.fetch('/api/session', { method: 'POST' })
  if (!sessionResponse.ok) {
    throw new Error(`session setup failed: ${sessionResponse.status}`)
  }
  const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('session setup returned no cookie')
  return client.fetch('/api/db/flush', {
    method: 'POST',
    headers: { cookie },
  })
}

describe('atomic database writes with external rows', () => {
  test('full write rolls back plugin and chat rows when database.bin kvSet fails', async () => {
    const { client, server } = await bootSeeded('key:database/database.bin')
    const before = snapshotExternalRows(server.cwd)

    const response = await writeFullDatabase(client, makeFullDatabase('new', false))

    expect(response.status).toBe(500)
    expect(snapshotExternalRows(server.cwd)).toEqual(before)
  })

  test('full write rolls back every row when the second chat kvSet fails', async () => {
    const { client, server } = await bootSeeded('prefix:chats/:2')
    const before = snapshotExternalRows(server.cwd)

    const response = await writeFullDatabase(client, makeFullDatabase('new', false))

    expect(response.status).toBe(500)
    expect(snapshotExternalRows(server.cwd)).toEqual(before)
  })

  test('full write commits chat rows and ETag without changing legacy-owned plugin rows', async () => {
    const { client, server } = await bootSeeded()
    const incoming = makeFullDatabase('new', false)

    const response = await writeFullDatabase(client, incoming)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.etag).toEqual(expect.any(String))
    expect(body.etag.length).toBeGreaterThan(0)

    const storedDb = decodeRisuDat(readKv(server.cwd, DB_KEY)!) as Record<string, any>
    expect(storedDb.pluginCustomStorage).toEqual({})
    expect(storedDb.pluginStorageMeta).toBeUndefined()
    for (const character of storedDb.characters) {
      for (const chat of character.chats) {
        expect(chat._stub).toBe(true)
        expect(chat.message).toBeUndefined()
        const storedChat = decodeRisuDat(readKv(
          server.cwd,
          chatRowKey(character.chaId, chat.id),
        )!) as Record<string, any>
        expect(storedChat.message[0].data).toContain('new message')
      }
    }
    expect(readKv(
      server.cwd,
      pluginStorageKey('pluginsave/', 'shared/key'),
    )).toEqual(Buffer.from(JSON.stringify({ version: 'old', nested: ['old', 1] })))
    expect(readKv(
      server.cwd,
      pluginStorageKey('pluginsave/', 'new/only'),
    )).toBeNull()
    expect(readKv(
      server.cwd,
      pluginStorageKey('pluginsave-meta/', 'shared/key'),
    )).toEqual(Buffer.from(JSON.stringify({ plugin: 'old plugin', updatedAt: 1 })))
  })

  test('patch removal keeps its row until database.bin and deletion commit together', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const removedChat = strippedDb.characters[0].chats[1]
    const removedKey = chatRowKey(strippedDb.characters[0].chaId, removedChat.id)
    const databaseBefore = readKv(server.cwd, DB_KEY)

    const patchResponse = await removeSecondChat(client, strippedDb)

    expect(patchResponse.status).toBe(200)
    expect(readKv(server.cwd, removedKey)).not.toBeNull()
    expect(readKv(server.cwd, DB_KEY)).toEqual(databaseBefore)

    const flushResponse = await flushDatabase(client)
    expect(flushResponse.status).toBe(200)
    const storedDb = decodeRisuDat(readKv(server.cwd, DB_KEY)!) as Record<string, any>
    expect(storedDb.characters[0].chats.map((chat: any) => chat.id)).not.toContain(removedChat.id)
    expect(readKv(server.cwd, removedKey)).toBeNull()
  })

  test('failed patch flush leaves database.bin and the pending chat row unchanged', async () => {
    const { client, server, strippedDb } = await bootSeeded('key:database/database.bin')
    const removedChat = strippedDb.characters[0].chats[1]
    const removedKey = chatRowKey(strippedDb.characters[0].chaId, removedChat.id)
    const databaseBefore = readKv(server.cwd, DB_KEY)
    const chatBefore = readKv(server.cwd, removedKey)

    const patchResponse = await removeSecondChat(client, strippedDb)
    expect(patchResponse.status).toBe(200)

    const flushResponse = await flushDatabase(client)
    expect(flushResponse.status).toBe(500)
    expect(readKv(server.cwd, DB_KEY)).toEqual(databaseBefore)
    expect(readKv(server.cwd, removedKey)).toEqual(chatBefore)
  })
})
