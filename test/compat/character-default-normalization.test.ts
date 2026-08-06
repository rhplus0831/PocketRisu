import { afterAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import defaultsPolicy from '../../shared/character-defaults-policy.json'
import utilsPkg from '../../server/node/utils.cjs'
import pluginSaveKeysPkg from '../../server/node/plugin-storage/pluginSaveKeys.cjs'
import pluginStorageJsonPkg from '../../server/node/plugin-storage/pluginStorageJson.cjs'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const {
  decodeAuthoritativeRisuSave,
  encodeRisuSaveLegacy,
} = utilsPkg as {
  decodeAuthoritativeRisuSave: (value: Uint8Array) => Promise<any>
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}
const { encodePluginSaveStorageKey } = pluginSaveKeysPkg as {
  encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
}
const { validatePluginStorageRow } = pluginStorageJsonPkg as {
  validatePluginStorageRow: (storageKey: string, value: Uint8Array) => unknown
}

const DB_KEY = 'database/database.bin'
const PLUGIN_MANIFEST_KEY = 'plugin-storage/manifest.json'
const PLUGIN_VALUE_PREFIX = 'pluginsave/'
const PLUGIN_META_PREFIX = 'pluginsave-meta/'
const CHAT_MARKER_KEY = 'migration/chats-externalized'
const DEFAULTS_MARKER_KEY = 'migration/character-defaults-normalized'
const DEFAULTS_BACKUP_PREFIX = 'migration-backup/pre-character-defaults-'
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function withOwn<T>(record: Record<string, T>, key: string, value: T): Record<string, T> {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
  return record
}

function readKv(cwd: string, key: string): Buffer | null {
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as {
      value: Buffer
    } | undefined
    return row ? Buffer.from(row.value) : null
  } finally {
    sqlite.close()
  }
}

function listKv(cwd: string, prefix: string): Array<{ key: string; value: Buffer }> {
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    return (sqlite.prepare(
      "SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
    ).all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) as Array<{
      key: string
      value: Buffer
    }>).map(row => ({ key: row.key, value: Buffer.from(row.value) }))
  } finally {
    sqlite.close()
  }
}

function readPluginRecord(
  cwd: string,
  prefix: string,
  rawKeys: string[],
): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const rawKey of rawKeys) {
    const storageKey = encodePluginSaveStorageKey(rawKey, prefix)
    const row = readKv(cwd, storageKey)
    if (row === null) throw new Error(`Missing external plugin row: ${storageKey}`)
    withOwn(record, rawKey, validatePluginStorageRow(storageKey, row))
  }
  return record
}

function missingCharacterIdBackup(): Buffer {
  return encodeBackup([{
    name: 'database.risudat',
    data: Buffer.from(encodeRisuSaveLegacy({
      characters: [{
        chaId: '',
        chats: [{
          id: 'missing-cha-chat',
          name: 'Retained chat',
          message: [{ role: 'user', data: 'must survive ingest' }],
        }],
      }],
      personas: [{ name: 'Nullish persona', id: null }, { name: 'Empty persona', id: '' }],
      botPresets: [{ name: 'Missing preset id', id: '' }],
      modules: [],
    })),
  }])
}

function seedExistingDatabase(saveDir: string, raw: Buffer): void {
  const sqlite = new Database(path.join(saveDir, 'risuai.db'))
  try {
    sqlite.exec(`
      CREATE TABLE kv (
        key        TEXT    PRIMARY KEY,
        value      BLOB    NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const insert = sqlite.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    insert.run(DB_KEY, raw, Date.now())
    insert.run(CHAT_MARKER_KEY, Buffer.from('done'), Date.now())
  } finally {
    sqlite.close()
  }
}

describe.each([
  ['full', { RISU_STREAM_INGEST_MIN_BYTES: String(1024 * 1024) }],
  ['streaming', { RISU_STREAM_INGEST_MIN_BYTES: '1' }],
] as const)('%s backup ingest character normalization', (_mode, env) => {
  test('assigns the character before chat-row publication and persists every contract fill', async () => {
    const server = await spawnServer({ env })
    servers.push(server)
    let client = await createClient(server.port, server.password)

    expect((await client.importBackup(missingCharacterIdBackup())).ok).toBe(true)
    const raw = readKv(server.cwd, DB_KEY)
    expect(raw).not.toBeNull()
    const database = await decodeAuthoritativeRisuSave(raw!)
    const character = database.characters[0]
    expect(character.chaId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    for (const [field, value] of Object.entries({
      ...defaultsPolicy.characterDefaults,
      ...defaultsPolicy.characterTypeDefaults,
    })) {
      if (field === 'chats') continue
      expect(character[field], field).toEqual(value)
    }
    expect(character.chats).toEqual([expect.objectContaining({
      id: 'missing-cha-chat',
      _stub: true,
    })])

    const chatRows = listKv(server.cwd, 'chats/')
    expect(chatRows.map(row => row.key)).toEqual([
      `chats/${encodeURIComponent(character.chaId)}/missing-cha-chat`,
    ])
    expect(chatRows.some(row => row.key.startsWith('chats/undefined/'))).toBe(false)
    expect(readKv(server.cwd, DEFAULTS_MARKER_KEY)?.toString()).toBe('done')
    expect(listKv(server.cwd, DEFAULTS_BACKUP_PREFIX)).toEqual([])

    const hydratedResponse = await client.fetch(
      `/api/chat-content/${encodeURIComponent(character.chaId)}/0`,
      { headers: { 'x-chat-id': 'missing-cha-chat' } },
    )
    expect(hydratedResponse.status).toBe(200)
    const hydrated = await decodeAuthoritativeRisuSave(
      new Uint8Array(await hydratedResponse.arrayBuffer()),
    )
    expect(hydrated.message).toEqual([{ role: 'user', data: 'must survive ingest' }])

    await server.restart()
    client = await createClient(server.port, server.password)
    expect((await client.fetch('/api/db/read-raw-for-boot')).status).toBe(200)
    expect(listKv(server.cwd, DEFAULTS_BACKUP_PREFIX)).toEqual([])
  })
})

describe.each([
  ['standard', {}],
  ['hub', { POCKETRISU_HUB_HOSTING: 'TRUE' }],
] as const)('%s boot migration', (_mode, env) => {
  test('runs once with a safety backup and preserves escaped plugin keys logically', async () => {
    const pluginValues = withOwn<Record<string, unknown>>(
      { ordinary: { value: 1 }, '\uD800': { malformed: true } },
      '__proto__',
      { own: true },
    )
    const collision = { user: 'reserved-field-collision', nested: ['kept', true] }
    const sourceDatabase = {
      characters: [{ chaId: 'migration-character', chats: [] }],
      personas: [{ id: 'migration-persona' }],
      botPresets: [{ id: 'migration-preset', name: 'Preset' }],
      optimizePluginMemory: false,
      pluginCustomStorage: pluginValues,
      __pocketRisuPluginStorageEscapesV1: collision,
    }
    const sourceBytes = Buffer.from(encodeRisuSaveLegacy(sourceDatabase))
    const sourceEtag = createHash('md5').update(sourceBytes).digest('hex')
    const server = await spawnServer({
      env,
      seedSave: async saveDir => seedExistingDatabase(saveDir, sourceBytes),
    })
    servers.push(server)
    let client = await createClient(server.port, server.password)

    const migratedBytes = readKv(server.cwd, DB_KEY)!
    const migratedEtag = createHash('md5').update(migratedBytes).digest('hex')
    expect(migratedEtag).not.toBe(sourceEtag)
    expect(readKv(server.cwd, DEFAULTS_MARKER_KEY)?.toString()).toBe('done')
    const backups = listKv(server.cwd, DEFAULTS_BACKUP_PREFIX)
    expect(backups).toHaveLength(1)
    expect(backups[0].value).toEqual(sourceBytes)

    const migrated = await decodeAuthoritativeRisuSave(migratedBytes)
    expect(Object.keys(migrated.pluginCustomStorage)).toEqual([
      'ordinary', '\uD800', '__proto__',
    ])
    expect(Object.hasOwn(migrated.pluginCustomStorage, '__proto__')).toBe(true)
    expect(migrated.pluginCustomStorage.__proto__).toEqual({ own: true })
    expect(migrated.pluginCustomStorage['\uD800']).toEqual({ malformed: true })
    expect(migrated.__pocketRisuPluginStorageEscapesV1).toEqual(collision)
    expect(migrated.characters[0]).toMatchObject({
      chaId: 'migration-character',
      ...defaultsPolicy.characterDefaults,
      ...defaultsPolicy.characterTypeDefaults,
    })

    const rawRead = await client.fetch('/api/db/read-raw-for-boot')
    expect(rawRead.status).toBe(200)
    expect(rawRead.headers.get('x-db-etag')).toBe(migratedEtag)
    await rawRead.arrayBuffer()

    await server.restart(env)
    client = await createClient(server.port, server.password)
    const secondRead = await client.fetch('/api/db/read-raw-for-boot')
    expect(secondRead.headers.get('x-db-etag')).toBe(migratedEtag)
    await secondRead.arrayBuffer()
    expect(readKv(server.cwd, DB_KEY)).toEqual(migratedBytes)
    expect(listKv(server.cwd, DEFAULTS_BACKUP_PREFIX)).toHaveLength(1)
  })

  test('preserves folded optimized plugin storage through the boot migration', async () => {
    const pluginValues = withOwn<Record<string, unknown>>(
      {
        ordinary: { value: 1, nested: ['kept', true] },
        '\uD800': { malformed: true },
      },
      '__proto__',
      { own: true },
    )
    const pluginMeta = withOwn<Record<string, unknown>>(
      {
        ordinary: { plugin: 'Ordinary plugin', updatedAt: 1 },
        '\uD800': { plugin: 'Malformed-key plugin', updatedAt: 2 },
      },
      '__proto__',
      { plugin: 'Prototype-key plugin', updatedAt: 3 },
    )
    const generation = 'folded-character-defaults-migration'
    const sourceDatabase = {
      characters: [{ chaId: 'folded-migration-character', chats: [] }],
      personas: [{ id: 'folded-migration-persona' }],
      botPresets: [{ id: 'folded-migration-preset', name: 'Preset' }],
      optimizePluginMemory: true,
      pluginStorageFolded: true,
      pluginStorageGeneration: generation,
      pluginCustomStorage: pluginValues,
      pluginStorageMeta: pluginMeta,
    }
    const sourceBytes = Buffer.from(encodeRisuSaveLegacy(sourceDatabase))
    const sourceEtag = createHash('md5').update(sourceBytes).digest('hex')
    const server = await spawnServer({
      env,
      seedSave: async saveDir => seedExistingDatabase(saveDir, sourceBytes),
    })
    servers.push(server)
    let client = await createClient(server.port, server.password)

    const migratedBytes = readKv(server.cwd, DB_KEY)!
    const migratedEtag = createHash('md5').update(migratedBytes).digest('hex')
    expect(migratedEtag).not.toBe(sourceEtag)
    expect(readKv(server.cwd, DEFAULTS_MARKER_KEY)?.toString()).toBe('done')
    const backups = listKv(server.cwd, DEFAULTS_BACKUP_PREFIX)
    expect(backups).toHaveLength(1)
    expect(backups[0].value).toEqual(sourceBytes)

    const migrated = await decodeAuthoritativeRisuSave(migratedBytes)
    expect(migrated).toMatchObject({
      optimizePluginMemory: true,
      pluginStorageGeneration: generation,
      pluginCustomStorage: {},
    })
    expect(migrated.pluginStorageFolded).toBeUndefined()
    expect(migrated.pluginStorageMeta).toBeUndefined()
    expect(migrated.characters[0]).toMatchObject({
      chaId: 'folded-migration-character',
      ...defaultsPolicy.characterDefaults,
      ...defaultsPolicy.characterTypeDefaults,
    })

    const rawKeys = Object.keys(pluginValues)
    expect(rawKeys).toEqual(['ordinary', '\uD800', '__proto__'])
    const valueKeys = rawKeys.map(key => encodePluginSaveStorageKey(key, PLUGIN_VALUE_PREFIX))
    const metaKeys = rawKeys.map(key => encodePluginSaveStorageKey(key, PLUGIN_META_PREFIX))
    expect(valueKeys).toContain('pluginsave/utf16-v1.2AA.json')
    expect(valueKeys).toContain('pluginsave/X19wcm90b19f.json')

    const manifest = JSON.parse(readKv(server.cwd, PLUGIN_MANIFEST_KEY)!.toString('utf8'))
    expect(manifest).toMatchObject({ generation, valueKeys, metaKeys })
    const migratedValues = readPluginRecord(server.cwd, PLUGIN_VALUE_PREFIX, rawKeys)
    const migratedMeta = readPluginRecord(server.cwd, PLUGIN_META_PREFIX, rawKeys)
    expect(Object.hasOwn(migratedValues, '__proto__')).toBe(true)
    expect(Object.hasOwn(migratedMeta, '__proto__')).toBe(true)
    expect(migratedValues).toEqual(pluginValues)
    expect(migratedMeta).toEqual(pluginMeta)

    await server.restart(env)
    client = await createClient(server.port, server.password)
    const secondRead = await client.fetch('/api/db/read-raw-for-boot')
    expect(secondRead.headers.get('x-db-etag')).toBe(migratedEtag)
    await secondRead.arrayBuffer()
    expect(readKv(server.cwd, DB_KEY)).toEqual(migratedBytes)
    expect(readPluginRecord(server.cwd, PLUGIN_VALUE_PREFIX, rawKeys)).toEqual(pluginValues)
    expect(readPluginRecord(server.cwd, PLUGIN_META_PREFIX, rawKeys)).toEqual(pluginMeta)
    expect(listKv(server.cwd, DEFAULTS_BACKUP_PREFIX)).toHaveLength(1)
  })
})
