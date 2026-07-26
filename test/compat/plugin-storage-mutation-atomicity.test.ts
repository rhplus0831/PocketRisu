import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import Database from 'better-sqlite3'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import {
  classifyPluginStorageMutationAcknowledgement,
  pluginStorageTransportOutcomeUnknown,
  publishPluginStorageMutationCache,
  type PluginStorageMutationResult,
} from '../../src/ts/storage/pluginStorageMutation.js'

const RAW_KEY = 'aa1/atomic-key'
const VALUE_KEY = `pluginsave/${Buffer.from(RAW_KEY, 'utf-8').toString('base64url')}.json`
const OWNER_KEY = `pluginsave-meta/${Buffer.from(RAW_KEY, 'utf-8').toString('base64url')}.json`
const OLD_VALUE = Buffer.from(JSON.stringify({ generation: 'old' }), 'utf-8')
const OLD_OWNER = Buffer.from(JSON.stringify({ plugin: 'Old Plugin', updatedAt: 1 }), 'utf-8')
const LONG_RAW_KEY = 'v'.repeat(756)
const LONG_VALUE_KEY = `pluginsave/${Buffer.from(LONG_RAW_KEY, 'utf-8').toString('base64url')}.json`
const LONG_OWNER_KEY = `pluginsave-meta/${Buffer.from(LONG_RAW_KEY, 'utf-8').toString('base64url')}.json`
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function seedRows(saveDir: string, includeValue = true, includeOwner = true): void {
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
    if (includeValue) insert.run(VALUE_KEY, OLD_VALUE, Date.now())
    if (includeOwner) insert.run(OWNER_KEY, OLD_OWNER, Date.now())
  } finally {
    database.close()
  }
}

async function boot(
  pluginFailpoint?:
    | 'owner-write'
    | 'owner-remove'
    | 'pre-commit'
    | 'verification-read'
    | 'acknowledgement-loss',
  kvFailpoint?: string,
  seed: (saveDir: string) => void = seedRows,
): Promise<{ server: ServerHandle; client: RisuClient }> {
  const server = await spawnServer({
    env: {
      ...(pluginFailpoint
        ? { POCKETRISU_TEST_PLUGIN_MUTATION_FAILPOINT: pluginFailpoint }
        : {}),
      ...(kvFailpoint ? { POCKETRISU_TEST_FAILPOINT: kvFailpoint } : {}),
    },
    seedSave: seed,
  })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

function readRows(cwd: string): { value: Buffer | null; owner: Buffer | null } {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const read = database.prepare('SELECT value FROM kv WHERE key = ?')
    const value = read.get(VALUE_KEY) as { value: Buffer } | undefined
    const owner = read.get(OWNER_KEY) as { value: Buffer } | undefined
    return {
      value: value ? Buffer.from(value.value) : null,
      owner: owner ? Buffer.from(owner.value) : null,
    }
  } finally {
    database.close()
  }
}

async function mutate(
  client: RisuClient,
  operation: 'set' | 'remove',
  value: unknown = { generation: 'new' },
  owner = 'New Plugin',
): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
      'x-plugin-storage-operation': operation,
      'x-plugin-storage-owner': Buffer.from(owner, 'utf-8').toString('base64url'),
    },
    body: operation === 'set'
      ? new Uint8Array(Buffer.from(JSON.stringify(value), 'utf-8'))
      : new Uint8Array(),
  })
}

async function mutateRaw(
  client: RisuClient,
  body: Uint8Array,
  owner = 'New Plugin',
): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
      'x-plugin-storage-operation': 'set',
      'x-plugin-storage-owner': Buffer.from(owner, 'utf-8').toString('base64url'),
    },
    body,
  })
}

async function restorePair(
  client: RisuClient,
  value: Uint8Array,
  ownerRecord?: Uint8Array,
): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
      'x-plugin-storage-operation': 'set',
      'x-plugin-storage-owner': '',
      'x-plugin-storage-owner-policy': ownerRecord ? 'record' : 'preserve',
      ...(ownerRecord
        ? { 'x-plugin-storage-owner-record': Buffer.from(ownerRecord).toString('base64url') }
        : {}),
    },
    body: value,
  })
}

async function mutateWithClientOutcome(
  client: RisuClient,
  operation: 'set' | 'remove',
  value: unknown = { generation: 'new' },
  owner = 'New Plugin',
): Promise<PluginStorageMutationResult> {
  try {
    const response = await mutate(client, operation, value, owner)
    let body: unknown = null
    try {
      body = await response.json()
    } catch {}
    return classifyPluginStorageMutationAcknowledgement(
      response.status,
      body,
      operation,
    )
  } catch (error) {
    return pluginStorageTransportOutcomeUnknown(operation, error)
  }
}

describe('atomic optimized plugin value and owner acknowledgement', () => {
  test('recovery atomically restores an exact sidecar or preserves the existing bytes', async () => {
    const { server, client } = await boot()
    const exactOwner = Buffer.from(JSON.stringify({ plugin: 'Snapshot', updatedAt: 7 }))
    const firstValue = Buffer.from(JSON.stringify({ generation: 'recovered' }))

    const restored = await restorePair(client, firstValue, exactOwner)
    expect(restored.status).toBe(200)
    expect(readRows(server.cwd)).toEqual({ value: firstValue, owner: exactOwner })

    const secondValue = Buffer.from(JSON.stringify({ generation: 'preserved' }))
    const preserved = await restorePair(client, secondValue)
    expect(preserved.status).toBe(200)
    expect(readRows(server.cwd)).toEqual({ value: secondValue, owner: exactOwner })
  })

  test('remove accepts a BR4-valid value-only key whose metadata name is oversized', async () => {
    const { server, client } = await boot(undefined, undefined, (saveDir) => {
      const database = new Database(path.join(saveDir, 'risuai.db'))
      try {
        database.exec(`
          CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        database.prepare(
          'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        ).run(LONG_VALUE_KEY, OLD_VALUE, Date.now())
      } finally {
        database.close()
      }
    })

    const response = await client.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(LONG_VALUE_KEY, 'utf-8').toString('hex'),
        'x-plugin-storage-operation': 'remove',
      },
      body: new Uint8Array(),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'remove',
    })
    const database = new Database(path.join(server.cwd, 'save', 'risuai.db'), {
      readonly: true,
    })
    try {
      const read = database.prepare('SELECT value FROM kv WHERE key = ?')
      expect(read.get(LONG_VALUE_KEY)).toBeUndefined()
      expect(read.get(LONG_OWNER_KEY)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  test('strict JSON rejection leaves the prior value and owner byte-exact', async () => {
    const { server, client } = await boot()

    const response = await mutateRaw(client, Buffer.from('1e400', 'utf-8'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      success: false,
      outcome: 'not-committed',
      operation: 'set',
      error: 'Invalid plugin storage JSON row',
      code: 'INVALID_PLUGIN_STORAGE_MUTATION',
      retryable: false,
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test('owner-write failure rolls the primary value back and reports not-committed', async () => {
    const { server, client } = await boot('owner-write')

    const response = await mutate(client, 'set')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'set',
      code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test('a primary write failure is surfaced and leaves the complete old state', async () => {
    const { server, client } = await boot(undefined, `key:${VALUE_KEY}`)

    const response = await mutate(client, 'set')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'set',
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test('owner-remove failure rolls the primary removal back', async () => {
    const { server, client } = await boot('owner-remove')

    const response = await mutate(client, 'remove')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'remove',
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test.each(['set', 'remove'] as const)(
    'pre-commit failure after both %s row mutations rolls the transaction back',
    async (operation) => {
      const { server, client } = await boot('pre-commit')

      const response = await mutate(client, operation)

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toMatchObject({
        outcome: 'not-committed',
        operation,
        code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
      })
      expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
    },
  )

  test('post-commit verification failure still acknowledges the complete new state', async () => {
    const { server, client } = await boot('verification-read')
    const newValue = { generation: 'new', nested: [1, 2] }

    const response = await mutate(client, 'set', newValue)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'set',
      verification: 'unavailable',
    })
    const rows = readRows(server.cwd)
    expect(JSON.parse(rows.value!.toString('utf-8'))).toEqual(newValue)
    expect(JSON.parse(rows.owner!.toString('utf-8'))).toMatchObject({
      plugin: 'New Plugin',
      updatedAt: expect.any(Number),
    })
  })

  test('empty owner removes stale metadata and remove cleans an owner orphan', async () => {
    const { server, client } = await boot()

    const setResponse = await mutate(client, 'set', { generation: 'unowned' }, '')
    expect(setResponse.status).toBe(200)
    await expect(setResponse.json()).resolves.toMatchObject({ outcome: 'committed' })
    let rows = readRows(server.cwd)
    expect(JSON.parse(rows.value!.toString('utf-8'))).toEqual({ generation: 'unowned' })
    expect(rows.owner).toBeNull()

    const database = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    try {
      database.prepare('DELETE FROM kv WHERE key = ?').run(VALUE_KEY)
      database.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
      ).run(OWNER_KEY, OLD_OWNER, Date.now())
    } finally {
      database.close()
    }

    const removeResponse = await mutate(client, 'remove')
    expect(removeResponse.status).toBe(200)
    await expect(removeResponse.json()).resolves.toMatchObject({ outcome: 'committed' })
    rows = readRows(server.cwd)
    expect(rows).toEqual({ value: null, owner: null })
  })

  test('post-commit acknowledgement loss leaves complete new state and no trusted response', async () => {
    const { server, client } = await boot('acknowledgement-loss')
    const newValue = { generation: 'committed-without-ack' }

    await expect(mutateWithClientOutcome(client, 'set', newValue)).resolves.toMatchObject({
      outcome: 'unknown',
      operation: 'set',
      code: 'TRANSPORT_OUTCOME_UNKNOWN',
    })

    const rows = readRows(server.cwd)
    expect(JSON.parse(rows.value!.toString('utf-8'))).toEqual(newValue)
    expect(JSON.parse(rows.owner!.toString('utf-8'))).toMatchObject({
      plugin: 'New Plugin',
      updatedAt: expect.any(Number),
    })
  })

  test('post-commit remove acknowledgement loss deletes both rows without cache publication', async () => {
    const { server, client } = await boot('acknowledgement-loss')

    const result = await mutateWithClientOutcome(client, 'remove')
    expect(result).toMatchObject({
      outcome: 'unknown',
      operation: 'remove',
      code: 'TRANSPORT_OUTCOME_UNKNOWN',
    })
    expect(readRows(server.cwd)).toEqual({ value: null, owner: null })

    const cacheActions: string[] = []
    await publishPluginStorageMutationCache({
      operation: 'remove',
      valueKey: VALUE_KEY,
    }, result, {
      enabled: true,
      storeValue: async () => { cacheActions.push('store') },
      invalidateValue: async () => { cacheActions.push('invalidate') },
    })
    expect(cacheActions).toEqual([])
  })
})
