import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import utilsPkg from '../../server/node/utils.cjs'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

const { decodeRisuSave, encodeRisuSaveLegacy } = utilsPkg as {
  decodeRisuSave: (value: Uint8Array) => Promise<any>
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const DB_KEY = 'database/database.bin'
const DB_PATH_HEX = Buffer.from(DB_KEY, 'utf-8').toString('hex')
const SESSION_ID = 'boot-database-negotiation-test'

let server: ServerHandle
let client: RisuClient

beforeAll(async () => {
  server = await spawnServer()
  client = await createClient(server.port, server.password)
})

afterAll(async () => {
  await server?.cleanup()
})

function writerHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ 'x-session-id': SESSION_ID, ...extra })
}

async function rawRead(): Promise<Response> {
  return client.fetch('/api/db/read-raw-for-boot')
}

async function createIfAbsent(): Promise<Response> {
  return client.fetch('/api/db/create-if-absent', {
    method: 'POST',
    headers: writerHeaders(),
  })
}

describe('boot database protocol negotiation', () => {
  test('advertises the protocol, reports explicit absence, and linearizes concurrent creation', async () => {
    const session = await client.fetch('/api/session', {
      method: 'POST',
      headers: writerHeaders(),
    })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({
      ok: true,
      capabilities: {
        database: {
          rawBootRead: true,
          atomicCreate: true,
          rawBootByteLength: null,
        },
      },
    })

    const missing = await rawRead()
    expect(missing.status).toBe(204)
    expect((await missing.arrayBuffer()).byteLength).toBe(0)

    const raced = await Promise.all([createIfAbsent(), createIfAbsent()])
    expect(raced.map(response => response.status).sort()).toEqual([201, 409])

    const createdResponse = raced.find(response => response.status === 201)!
    const conflictResponse = raced.find(response => response.status === 409)!
    const created = await createdResponse.json() as Record<string, unknown>
    const conflict = await conflictResponse.json() as Record<string, unknown>
    expect(created).toMatchObject({
      success: true,
      created: true,
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })
    expect(created.etag).toMatch(/^[0-9a-f]{32}$/)
    expect(conflict).toMatchObject({
      success: false,
      created: false,
      code: 'DATABASE_ALREADY_EXISTS',
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(conflict.currentEtag).toBe(created.etag)

    const live = await rawRead()
    expect(live.status).toBe(200)
    expect(live.headers.get('x-db-etag')).toBe(created.etag)
    const liveBytes = new Uint8Array(await live.arrayBuffer())
    expect(await decodeRisuSave(liveBytes)).toEqual({})

    const registeredWithDatabase = await client.fetch('/api/session', {
      method: 'POST',
      headers: writerHeaders(),
    })
    expect(registeredWithDatabase.status).toBe(200)
    await expect(registeredWithDatabase.json()).resolves.toMatchObject({
      ok: true,
      capabilities: {
        database: {
          rawBootByteLength: liveBytes.byteLength,
        },
      },
    })

    const ordinary = await client.fetch('/api/read', {
      headers: { 'file-path': DB_PATH_HEX },
    })
    expect(ordinary.status).toBe(200)
    expect(ordinary.headers.get('x-db-etag')).toBe(created.etag)
  })

  test('never replaces an existing database through create-if-absent', async () => {
    const sentinel = {
      characters: [],
      sentinel: 'must-survive-create-conflict',
    }
    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: writerHeaders({
        'content-type': 'application/octet-stream',
        'file-path': DB_PATH_HEX,
      }),
      body: encodeRisuSaveLegacy(sentinel) as BodyInit,
    })
    expect(write.status).toBe(200)

    const before = await rawRead()
    expect(before.status).toBe(200)
    const beforeBytes = Buffer.from(await before.arrayBuffer())

    const conflict = await createIfAbsent()
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'DATABASE_ALREADY_EXISTS',
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const after = await rawRead()
    expect(after.status).toBe(200)
    const afterBytes = Buffer.from(await after.arrayBuffer())
    expect(afterBytes).toEqual(beforeBytes)
    expect(await decodeRisuSave(afterBytes)).toMatchObject(sentinel)
  })

  test('keeps session registration available when the size query fails', async () => {
    const storageErrorServer = await spawnServer()
    try {
      const storageErrorClient = await createClient(
        storageErrorServer.port,
        storageErrorServer.password,
      )
      const sqlite = new Database(path.join(storageErrorServer.cwd, 'save', 'risuai.db'))
      try {
        sqlite.exec('DROP TABLE kv')
      } finally {
        sqlite.close()
      }

      const response = await storageErrorClient.fetch('/api/session', {
        method: 'POST',
        headers: { 'x-session-id': 'storage-error-session' },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        capabilities: {
          database: {
            rawBootRead: true,
            rawBootByteLength: null,
          },
        },
      })
    } finally {
      await storageErrorServer.cleanup()
    }
  })
})
