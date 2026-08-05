import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const require = createRequire(import.meta.url)
const { calculateHash, encodeRisuSaveLegacy, normalizeJSON } = require('../../server/node/utils.cjs') as {
  calculateHash: (value: unknown) => number
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
  normalizeJSON: (value: unknown) => Record<string, any>
}

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const DB_KEY = 'database/database.bin'
const CHARACTER_DEFAULTS_MIGRATION_KEY = 'migration/character-defaults-normalized'
const DB_PATH_HEX = Buffer.from(DB_KEY, 'utf-8').toString('hex')
const DB_ENCODING_STATS_PATH = 'save/db-canonical-encoding-stats.json'
const CANONICAL_ETAG_FIXTURE = {
  characters: [],
  botPresets: [],
  modules: [],
  personas: [],
  marker: 'etag-fixture-한글',
}
const PATCHED_ETAG_FIXTURE = {
  ...CANONICAL_ETAG_FIXTURE,
  patched: true,
}
const CANONICAL_ETAG_FIXTURE_HEX = '005249535553415645000785aa6368617261637465727390aa626f745072657365747390a76d6f64756c657390a8706572736f6e617390a66d61726b6572b3657461672d666978747572652ded959ceab880'
const PATCHED_ETAG_FIXTURE_HEX = '005249535553415645000786aa6368617261637465727390aa626f745072657365747390a76d6f64756c657390a8706572736f6e617390a66d61726b6572b3657461672d666978747572652ded959ceab880a770617463686564c3'
const FULL_WRITE_ETAG_FIXTURE_HEX = '005249535553415645000785aa6368617261637465727390aa626f745072657365747390a76d6f64756c657390a8706572736f6e617390a66d61726b6572b266756c6c2d77726974652d66697874757265'
const CANONICAL_ETAG_FIXTURE_MD5 = '6e82d052c924efc4c599e8debcebd381'
const PATCHED_ETAG_FIXTURE_MD5 = '54fa7bbe51542a5b79458492e977c666'
const FULL_WRITE_ETAG_FIXTURE_MD5 = '2448b9360ff1e973f728cd051b0e6317'
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
  rows.set(CHARACTER_DEFAULTS_MIGRATION_KEY, Buffer.from('done'))
  return { strippedDb, rows }
}

async function bootSeeded(failpoint?: string, blockChatBackupRoot = false): Promise<{
  client: RisuClient
  server: ServerHandle
  strippedDb: Record<string, any>
}> {
  const seed = makeExternalizedSeed()
  const server = await spawnServer({
    env: {
      ...(failpoint ? { POCKETRISU_TEST_FAILPOINT: failpoint } : {}),
      ...(blockChatBackupRoot
        ? { POCKETRISU_CHAT_BACKUP_DIR: 'save/chat-backups-blocked' }
        : {}),
    },
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
      if (blockChatBackupRoot) {
        await writeFile(path.join(saveDir, 'chat-backups-blocked'), 'not a directory')
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

interface CanonicalEncodingStats {
  fullEncodes: number
  retained: boolean
  retainedGeneration: number | null
  retainedRevision: number | null
  releases: Record<string, number>
}

function readCanonicalEncodingStats(cwd: string): CanonicalEncodingStats {
  return JSON.parse(
    readFileSync(path.join(cwd, DB_ENCODING_STATS_PATH), 'utf-8'),
  ) as CanonicalEncodingStats
}

async function bootCanonicalEtagFixture(options: {
  failpoint?: string
} = {}): Promise<{ client: RisuClient, server: ServerHandle }> {
  const server = await spawnServer({
    env: {
      POCKETRISU_TEST_DB_CANONICAL_ENCODING_STATS_PATH: DB_ENCODING_STATS_PATH,
      ...(options.failpoint ? { POCKETRISU_TEST_FAILPOINT: options.failpoint } : {}),
    },
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
        const now = Date.now()
        insert.run(DB_KEY, Buffer.from(CANONICAL_ETAG_FIXTURE_HEX, 'hex'), now)
        insert.run('migration/chats-externalized', Buffer.from('done'), now)
        insert.run('migration/disable-remote-saving', Buffer.from('done'), now)
        insert.run(CHARACTER_DEFAULTS_MIGRATION_KEY, Buffer.from('done'), now)
      } finally {
        database.close()
      }
    },
  })
  servers.push(server)
  return { client: await createClient(server.port, server.password), server }
}

async function patchCanonicalEtagFixture(client: RisuClient): Promise<Response> {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'file-path': DB_PATH_HEX,
    },
    body: JSON.stringify({
      expectedHash: calculateHash(normalizeJSON(CANONICAL_ETAG_FIXTURE)).toString(16),
      patch: [{ op: 'add', path: '/patched', value: true }],
    }),
  })
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
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

async function readDatabaseEtag(client: RisuClient): Promise<string> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': DB_PATH_HEX },
  })
  if (!response.ok) throw new Error(`database read failed: ${response.status}`)
  await response.arrayBuffer()
  const etag = response.headers.get('x-db-etag')
  if (!etag) throw new Error('database read returned no ETag')
  return etag
}

describe('atomic database writes with external rows', () => {
  test('shares one canonical patch encoding with persistence and preserves ETag bytes', async () => {
    const { client, server } = await bootCanonicalEtagFixture()

    expect(Buffer.from(encodeRisuSaveLegacy(CANONICAL_ETAG_FIXTURE)).toString('hex'))
      .toBe(CANONICAL_ETAG_FIXTURE_HEX)
    expect(Buffer.from(encodeRisuSaveLegacy(PATCHED_ETAG_FIXTURE)).toString('hex'))
      .toBe(PATCHED_ETAG_FIXTURE_HEX)

    const initialRead = await client.fetch('/api/read', {
      headers: { 'file-path': DB_PATH_HEX },
    })
    expect(initialRead.status).toBe(200)
    expect(initialRead.headers.get('x-db-etag')).toBe(CANONICAL_ETAG_FIXTURE_MD5)
    expect(Buffer.from(await initialRead.arrayBuffer()).toString('hex'))
      .toBe(CANONICAL_ETAG_FIXTURE_HEX)

    const patchResponse = await patchCanonicalEtagFixture(client)
    expect(patchResponse.status).toBe(200)
    await expect(patchResponse.json()).resolves.toMatchObject({
      success: true,
      etag: PATCHED_ETAG_FIXTURE_MD5,
    })
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 1,
      retained: true,
    })

    const flushResponse = await flushDatabase(client)
    expect(flushResponse.status).toBe(200)
    expect(readKv(server.cwd, DB_KEY)?.toString('hex')).toBe(PATCHED_ETAG_FIXTURE_HEX)
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 1,
      retained: false,
      releases: { 'persist-success': 1 },
    })

    const ordinary = await client.fetch('/api/read', {
      headers: { 'file-path': DB_PATH_HEX },
    })
    expect(ordinary.headers.get('x-db-etag')).toBe(PATCHED_ETAG_FIXTURE_MD5)
    expect(Buffer.from(await ordinary.arrayBuffer()).toString('hex'))
      .toBe(PATCHED_ETAG_FIXTURE_HEX)

    const cached = await client.fetch('/api/db/read-cached', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cache: {
          version: 1,
          hashes: { root: [], characters: [], botPresets: [], modules: [], personas: [] },
        },
      }),
    })
    expect(cached.status).toBe(200)
    expect(cached.headers.get('x-db-etag')).toBe(PATCHED_ETAG_FIXTURE_MD5)

    const raw = await client.fetch('/api/db/read-raw-for-boot')
    const rawBytes = Buffer.from(await raw.arrayBuffer())
    expect(raw.headers.get('x-db-etag')).toBe(PATCHED_ETAG_FIXTURE_MD5)
    expect(rawBytes.toString('hex')).toBe(PATCHED_ETAG_FIXTURE_HEX)
    expect(md5(rawBytes)).toBe(PATCHED_ETAG_FIXTURE_MD5)
  })

  test('full writes flush and discard retained patch bytes before replacing the generation', async () => {
    const { client, server } = await bootCanonicalEtagFixture()
    const patchResponse = await patchCanonicalEtagFixture(client)
    const patchBody = await patchResponse.json() as { etag: string }
    expect(patchResponse.status).toBe(200)
    expect(readCanonicalEncodingStats(server.cwd).retained).toBe(true)

    const replacement = {
      characters: [],
      botPresets: [],
      modules: [],
      personas: [],
      marker: 'full-write-fixture',
    }
    const replacementBytes = Buffer.from(encodeRisuSaveLegacy(replacement))
    expect(replacementBytes.toString('hex')).toBe(FULL_WRITE_ETAG_FIXTURE_HEX)
    const writeResponse = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': DB_PATH_HEX,
        'x-if-match': patchBody.etag,
      },
      body: new Uint8Array(replacementBytes),
    })
    expect(writeResponse.status).toBe(200)
    await expect(writeResponse.json()).resolves.toMatchObject({
      etag: FULL_WRITE_ETAG_FIXTURE_MD5,
    })
    expect(md5(replacementBytes)).toBe(FULL_WRITE_ETAG_FIXTURE_MD5)
    expect(readKv(server.cwd, DB_KEY)).toEqual(replacementBytes)
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 1,
      retained: false,
      releases: { 'persist-success': 1 },
    })
  })

  test('a replacement patch releases the cancelled timer generation and persists only the latest bytes', async () => {
    const { client, server } = await bootCanonicalEtagFixture()
    expect((await patchCanonicalEtagFixture(client)).status).toBe(200)

    const latestFixture = { ...PATCHED_ETAG_FIXTURE, latest: 'acknowledged' }
    const replacementPatch = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(PATCHED_ETAG_FIXTURE)).toString(16),
        patch: [{ op: 'add', path: '/latest', value: latestFixture.latest }],
      }),
    })
    expect(replacementPatch.status).toBe(200)
    const latestBytes = Buffer.from(encodeRisuSaveLegacy(latestFixture))
    await expect(replacementPatch.json()).resolves.toMatchObject({ etag: md5(latestBytes) })
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 2,
      retained: true,
      releases: { 'cache-replace': 1 },
    })

    expect((await flushDatabase(client)).status).toBe(200)
    expect(readKv(server.cwd, DB_KEY)).toEqual(latestBytes)
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 2,
      retained: false,
      releases: { 'cache-replace': 1, 'persist-success': 1 },
    })
  })

  test('external revision conflicts discard retained bytes and keep the conflict envelope', async () => {
    const { client, server } = await bootCanonicalEtagFixture()
    expect((await patchCanonicalEtagFixture(client)).status).toBe(200)
    expect(readCanonicalEncodingStats(server.cwd).retained).toBe(true)

    const externalBytes = Buffer.from(encodeRisuSaveLegacy({
      ...CANONICAL_ETAG_FIXTURE,
      external: true,
    }))
    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    try {
      sqlite.prepare('UPDATE kv SET value = ? WHERE key = ?').run(externalBytes, DB_KEY)
    } finally {
      sqlite.close()
    }

    const conflict = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(PATCHED_ETAG_FIXTURE)).toString(16),
        patch: [{ op: 'add', path: '/secondPatch', value: true }],
      }),
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toEqual({
      error: 'The authoritative database changed outside the decoded cache lifecycle',
      code: 'DATABASE_CACHE_REVISION_CONFLICT',
      retryable: false,
    })
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 1,
      retained: false,
      releases: { 'external-revision-conflict': 1 },
    })
  })

  test('persist failure releases retained bytes for bounded retry', async () => {
    const { client, server } = await bootCanonicalEtagFixture({
      failpoint: 'key:database/database.bin',
    })
    expect((await patchCanonicalEtagFixture(client)).status).toBe(200)

    const flushResponse = await flushDatabase(client)
    expect(flushResponse.status).toBe(500)
    expect(readKv(server.cwd, DB_KEY)?.toString('hex')).toBe(CANONICAL_ETAG_FIXTURE_HEX)
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 1,
      retained: false,
      releases: { 'persist-error': 1 },
    })
  })

  test('graceful shutdown persists the acknowledged encoding and releases it', async () => {
    const { client, server } = await bootCanonicalEtagFixture()
    expect((await patchCanonicalEtagFixture(client)).status).toBe(200)
    expect(readCanonicalEncodingStats(server.cwd).retained).toBe(true)

    await server.restart()

    expect(readKv(server.cwd, DB_KEY)?.toString('hex')).toBe(PATCHED_ETAG_FIXTURE_HEX)
    expect(readCanonicalEncodingStats(server.cwd)).toMatchObject({
      fullEncodes: 1,
      retained: false,
      releases: { 'persist-success': 1 },
    })
  })

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

  test('full write rejects duplicate cold-chat ids without changing authoritative state', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const before = snapshotExternalRows(server.cwd)
    const malformed = structuredClone(strippedDb)
    malformed.characters[0].chats.splice(1, 0, {
      ...malformed.characters[0].chats[0],
      name: 'Duplicate row identity',
    })

    const response = await writeFullDatabase(client, malformed)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Write aborted: chat data integrity check failed',
    })
    expect(snapshotExternalRows(server.cwd)).toEqual(before)
  })

  test('patch hash mismatch returns a stable database-conflict envelope', async () => {
    const { client, strippedDb } = await bootSeeded()
    const expectedCurrentEtag = md5(
      Buffer.from(encodeRisuSaveLegacy(normalizeJSON(strippedDb))),
    )

    const response = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: 'stale-client-hash',
        patch: [{ op: 'replace', path: '/username', value: 'local edit' }],
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Hash mismatch - data out of sync',
      code: 'DATABASE_PATCH_CONFLICT',
      currentEtag: expectedCurrentEtag,
    })
  })

  test('mixed-case hex paths share one patch cache identity', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const afterUppercasePatch = structuredClone(strippedDb)
    afterUppercasePatch.storageKeyIdentityMarker = 'uppercase patch'

    const uppercasePatch = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX.toUpperCase(),
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: [{
          op: 'add',
          path: '/storageKeyIdentityMarker',
          value: afterUppercasePatch.storageKeyIdentityMarker,
        }],
      }),
    })
    expect(uppercasePatch.status).toBe(200)

    const canonicalPatch = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(afterUppercasePatch)).toString(16),
        patch: [{
          op: 'replace',
          path: '/storageKeyIdentityMarker',
          value: 'canonical patch',
        }],
      }),
    })
    expect(canonicalPatch.status).toBe(200)
    expect((await flushDatabase(client)).status).toBe(200)

    const storedDb = decodeRisuDat(readKv(server.cwd, DB_KEY)!) as Record<string, any>
    expect(storedDb.storageKeyIdentityMarker).toBe('canonical patch')
  })

  test('a noncanonical patch timer cannot overwrite a later full write', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const uppercasePatch = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX.toUpperCase(),
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: [{
          op: 'add',
          path: '/storageKeyIdentityMarker',
          value: 'stale patch',
        }],
      }),
    })
    expect(uppercasePatch.status).toBe(200)

    const fullWrite = makeFullDatabase('new', false)
    fullWrite.storageKeyIdentityMarker = 'full write'
    const writeResponse = await writeFullDatabase(client, fullWrite)
    expect(writeResponse.status).toBe(200)

    const committedBytes = readKv(server.cwd, DB_KEY)
    expect(committedBytes).not.toBeNull()
    expect((decodeRisuDat(committedBytes!) as Record<string, any>).storageKeyIdentityMarker)
      .toBe('full write')

    await new Promise(resolve => setTimeout(resolve, 5_500))

    const afterTimerBytes = readKv(server.cwd, DB_KEY)
    expect(afterTimerBytes).toEqual(committedBytes)
    expect((decodeRisuDat(afterTimerBytes!) as Record<string, any>).storageKeyIdentityMarker)
      .toBe('full write')
  })

  test('patch rejects a duplicate cold-chat id before updating the cache', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const before = snapshotExternalRows(server.cwd)
    const duplicate = {
      ...strippedDb.characters[0].chats[0],
      name: 'Duplicate row identity',
    }

    const response = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: [{ op: 'add', path: '/characters/0/chats/1', value: duplicate }],
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'DUPLICATE_CHAT_IDS',
      currentEtag: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(snapshotExternalRows(server.cwd)).toEqual(before)
  })

  test('patch rejects two payload chats without committing rows, database bytes, or ETag', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const databaseBefore = readKv(server.cwd, DB_KEY)
    const etagBefore = await readDatabaseEtag(client)
    const chaId = strippedDb.characters[0].chaId as string
    const payloadChats = [
      {
        id: 'patch-payload-one',
        name: 'First rejected payload',
        message: [{ role: 'user', data: 'must never reach a row' }],
      },
      {
        id: 'patch-payload-two',
        name: 'Second rejected payload',
        message: [{ role: 'char', data: 'must not partially commit' }],
      },
    ]

    const response = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: payloadChats.map((chat, index) => ({
          op: 'add',
          path: `/characters/0/chats/${2 + index}`,
          value: chat,
        })),
      }),
    })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      error: 'Patch rejected: whole-chat payloads must be written through /api/chat-content',
      code: 'CHAT_PAYLOAD_PATCH_UNSUPPORTED',
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
      currentEtag: etagBefore,
    })
    for (const chat of payloadChats) {
      expect(readKv(server.cwd, chatRowKey(chaId, chat.id))).toBeNull()
    }
    expect(readKv(server.cwd, DB_KEY)).toEqual(databaseBefore)
    expect(await readDatabaseEtag(client)).toBe(etagBefore)
  })

  test('patch rejects a payload overwrite and accepts a later stub-only patch', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const existingStub = strippedDb.characters[0].chats[0]
    const chaId = strippedDb.characters[0].chaId as string
    const rowKey = chatRowKey(chaId, existingStub.id)
    const rowBefore = readKv(server.cwd, rowKey)
    const databaseBefore = readKv(server.cwd, DB_KEY)
    const etagBefore = await readDatabaseEtag(client)
    const payloadReplacement = {
      ...(decodeRisuDat(rowBefore!) as Record<string, any>),
      name: 'Rejected authoritative overwrite',
      message: [{ role: 'user', data: 'must not replace the existing row' }],
    }

    const rejected = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: [{
          op: 'replace',
          path: '/characters/0/chats/0',
          value: payloadReplacement,
        }],
      }),
    })

    expect(rejected.status).toBe(422)
    await expect(rejected.json()).resolves.toMatchObject({
      code: 'CHAT_PAYLOAD_PATCH_UNSUPPORTED',
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
      currentEtag: etagBefore,
    })
    expect(readKv(server.cwd, rowKey)).toEqual(rowBefore)
    expect(readKv(server.cwd, DB_KEY)).toEqual(databaseBefore)
    expect(await readDatabaseEtag(client)).toBe(etagBefore)

    const updatedStub = { ...existingStub, name: 'Accepted stub metadata' }
    const stubOnly = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: [{
          op: 'replace',
          path: '/characters/0/chats/0',
          value: updatedStub,
        }],
      }),
    })

    expect(stubOnly.status).toBe(200)
    expect((await flushDatabase(client)).status).toBe(200)
    const storedDb = decodeRisuDat(readKv(server.cwd, DB_KEY)!) as Record<string, any>
    expect(storedDb.characters[0].chats[0]).toEqual(updatedStub)
    expect(readKv(server.cwd, rowKey)).toEqual(rowBefore)
  })

  test('patch removal commits database.bin and its row deletion before acknowledgement', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const removedChat = strippedDb.characters[0].chats[1]
    const removedKey = chatRowKey(strippedDb.characters[0].chaId, removedChat.id)
    const databaseBefore = readKv(server.cwd, DB_KEY)

    const patchResponse = await removeSecondChat(client, strippedDb)

    expect(patchResponse.status).toBe(200)
    await expect(patchResponse.json()).resolves.toMatchObject({ durable: true })
    expect(readKv(server.cwd, DB_KEY)).not.toEqual(databaseBefore)
    const storedDb = decodeRisuDat(readKv(server.cwd, DB_KEY)!) as Record<string, any>
    expect(storedDb.characters[0].chats.map((chat: any) => chat.id)).not.toContain(removedChat.id)
    expect(readKv(server.cwd, removedKey)).toBeNull()
  })

  test('deleting a chat after its first save creates a restorable forced pre-image', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const chaId = strippedDb.characters[0].chaId as string
    const chatId = 'young-chat-first-save'
    const chat = {
      id: chatId,
      name: 'Young chat',
      message: [{ role: 'user', data: 'only durable copy' }],
      note: '',
      localLore: [],
    }
    const rawChat = encodeRisuDat(chat)

    const chatSave = await client.fetch(`/api/chat-content/${encodeURIComponent(chaId)}/2`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': chatId,
      },
      body: new Uint8Array(rawChat),
    })
    expect(chatSave.status).toBe(200)

    const withYoungChat = structuredClone(strippedDb)
    const youngStub = { id: chatId, name: chat.name, _stub: true }
    withYoungChat.characters[0].chats.push(youngStub)
    const addStub = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: [{ op: 'add', path: '/characters/0/chats/2', value: youngStub }],
      }),
    })
    expect(addStub.status).toBe(200)
    expect((await flushDatabase(client)).status).toBe(200)

    const beforeDelete = await client.fetch(
      `/api/chat-backups/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`,
    )
    expect(beforeDelete.status).toBe(200)
    await expect(beforeDelete.json()).resolves.toEqual({ versions: [] })

    const removeStub = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(withYoungChat)).toString(16),
        patch: [{ op: 'remove', path: '/characters/0/chats/2' }],
      }),
    })
    expect(removeStub.status).toBe(200)
    expect((await flushDatabase(client)).status).toBe(200)
    expect(readKv(server.cwd, chatRowKey(chaId, chatId))).toBeNull()

    const historyResponse = await client.fetch(
      `/api/chat-backups/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`,
    )
    expect(historyResponse.status).toBe(200)
    const history = await historyResponse.json() as {
      versions: Array<{ versionId: string; reason: string }>
    }
    expect(history.versions).toHaveLength(1)
    expect(history.versions[0].reason).toBe('delete-chat')

    const versionResponse = await client.fetch(
      `/api/chat-backups/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}/${history.versions[0].versionId}`,
    )
    expect(versionResponse.status).toBe(200)
    expect(Buffer.from(await versionResponse.arrayBuffer())).toEqual(rawChat)
  })

  test('full-write fallback captures removed chat rows before committing deletion', async () => {
    const { client, server, strippedDb } = await bootSeeded()
    const removedChat = strippedDb.characters[0].chats[1]
    const chaId = strippedDb.characters[0].chaId as string
    const removedKey = chatRowKey(chaId, removedChat.id)
    const removedRaw = readKv(server.cwd, removedKey)
    const warmCache = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(strippedDb)).toString(16),
        patch: [{
          op: 'test',
          path: '/characters/0/chaId',
          value: chaId,
        }],
      }),
    })
    expect(warmCache.status).toBe(200)
    const incoming = makeFullDatabase('new', false)
    incoming.characters[0].chats.splice(1, 1)

    const response = await writeFullDatabase(client, incoming)

    expect(response.status).toBe(200)
    expect(readKv(server.cwd, removedKey)).toBeNull()
    const historyResponse = await client.fetch(
      `/api/chat-backups/${encodeURIComponent(chaId)}/${encodeURIComponent(removedChat.id)}`,
    )
    const history = await historyResponse.json() as {
      versions: Array<{ versionId: string; reason: string }>
    }
    expect(history.versions).toHaveLength(1)
    expect(history.versions[0].reason).toBe('delete-chat')
    const versionResponse = await client.fetch(
      `/api/chat-backups/${encodeURIComponent(chaId)}/${encodeURIComponent(removedChat.id)}/${history.versions[0].versionId}`,
    )
    expect(Buffer.from(await versionResponse.arrayBuffer())).toEqual(removedRaw)
  })

  test('failed deletion pre-image leaves database.bin and the chat row unchanged', async () => {
    const { client, server, strippedDb } = await bootSeeded(undefined, true)
    const removedChat = strippedDb.characters[0].chats[1]
    const removedKey = chatRowKey(strippedDb.characters[0].chaId, removedChat.id)
    const databaseBefore = readKv(server.cwd, DB_KEY)
    const chatBefore = readKv(server.cwd, removedKey)

    const patchResponse = await removeSecondChat(client, strippedDb)
    expect(patchResponse.status).toBe(200)
    await expect(patchResponse.json()).resolves.toMatchObject({
      success: true,
      durable: false,
      persistWarning: { source: 'patch:database/database.bin' },
    })

    const flushResponse = await flushDatabase(client)
    expect(flushResponse.status).toBe(500)
    expect(readKv(server.cwd, DB_KEY)).toEqual(databaseBefore)
    expect(readKv(server.cwd, removedKey)).toEqual(chatBefore)
  })

  test('failed patch flush leaves database.bin and the pending chat row unchanged', async () => {
    const { client, server, strippedDb } = await bootSeeded('key:database/database.bin')
    const removedChat = strippedDb.characters[0].chats[1]
    const removedKey = chatRowKey(strippedDb.characters[0].chaId, removedChat.id)
    const databaseBefore = readKv(server.cwd, DB_KEY)
    const chatBefore = readKv(server.cwd, removedKey)

    const patchResponse = await removeSecondChat(client, strippedDb)
    expect(patchResponse.status).toBe(200)
    await expect(patchResponse.json()).resolves.toMatchObject({
      success: true,
      durable: false,
      persistWarning: { source: 'patch:database/database.bin' },
    })

    const flushResponse = await flushDatabase(client)
    expect(flushResponse.status).toBe(500)
    expect(readKv(server.cwd, DB_KEY)).toEqual(databaseBefore)
    expect(readKv(server.cwd, removedKey)).toEqual(chatBefore)
  })
})
