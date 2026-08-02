import { afterAll, describe, expect, test } from 'vitest'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

const require = createRequire(import.meta.url)
const { calculateHash, decodeRisuSave, normalizeJSON } = require('../../server/node/utils.cjs') as {
  calculateHash: (value: unknown) => number
  decodeRisuSave: (value: Uint8Array) => Promise<Record<string, unknown>>
  normalizeJSON: (value: unknown) => Record<string, unknown>
}

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const MAGIC_COMPRESSED = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8])
const packr = new Packr({ useRecords: false })
const DB_KEY = 'database/database.bin'
const DB_PATH = Buffer.from(DB_KEY).toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encode(value: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

function encodeCompressed(value: unknown): Buffer {
  return Buffer.concat([MAGIC_COMPRESSED, gzipSync(packr.encode(value))])
}

async function boot(env: Record<string, string> = {}) {
  const server = await spawnServer({ env })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

async function writeDatabase(
  client: RisuClient,
  value: Record<string, unknown>,
  ifMatch?: string,
) {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': DB_PATH,
      ...(ifMatch ? { 'x-if-match': ifMatch } : {}),
    },
    body: new Uint8Array(encode(value)),
  })
}

async function responseSnapshot(response: Response) {
  return { status: response.status, body: await response.text() }
}

async function admittedArtifacts(server: ServerHandle): Promise<string[]> {
  const entries = await readdir(path.join(server.cwd, 'save', '.spool')).catch(() => [])
  return entries.filter(name => (
    name.startsWith('.admitted-ingress-')
    || name.startsWith('.admitted-write-stage-')
  ))
}

async function waitFor(pathname: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(pathname)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${pathname}`)
}

describe('admitted database/chat/KV write spooling', () => {
  test('new, legacy-buffered, and worker-degraded paths return byte-identical responses', async () => {
    const current = await boot({ POCKETRISU_CHUNK_THRESHOLD: '1024' })
    const legacy = await boot({
      POCKETRISU_CHUNK_THRESHOLD: '1024',
      POCKETRISU_TEST_DISABLE_ADMITTED_SPOOL: '1',
    })
    const degraded = await boot({
      POCKETRISU_CHUNK_THRESHOLD: '1024',
      POCKETRISU_TEST_CHUNK_WORKER_FAIL: '1',
    })
    const targets = [current, legacy, degraded]
    const database = {
      characters: [],
      botPresets: [],
      modules: [],
      personas: [],
      marker: 'byte-parity',
    }

    const successes = await Promise.all(targets.map(async ({ client }) => (
      responseSnapshot(await writeDatabase(client, database))
    )))
    expect(successes[1]).toEqual(successes[0])
    expect(successes[2]).toEqual(successes[0])
    const etag = (JSON.parse(successes[0].body) as { etag: string }).etag

    const stale = await Promise.all(targets.map(async ({ client }) => (
      responseSnapshot(await writeDatabase(client, { ...database, marker: 'stale' }, 'stale-etag'))
    )))
    expect(stale[0]).toEqual({
      status: 409,
      body: JSON.stringify({
        error: 'ETag mismatch - concurrent modification detected',
        currentEtag: etag,
      }),
    })
    expect(stale[1]).toEqual(stale[0])
    expect(stale[2]).toEqual(stale[0])

    const chatBytes = encode({
      id: 'spooled-chat',
      name: 'Spool parity',
      message: [{ role: 'user', data: 'same bytes' }],
    })
    const chats = await Promise.all(targets.map(async ({ client }) => responseSnapshot(
      await client.fetch('/api/chat-content/spool-char/0', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-chat-id': 'spooled-chat',
        },
        body: new Uint8Array(chatBytes),
      }),
    )))
    expect(chats[1]).toEqual(chats[0])
    expect(chats[2]).toEqual(chats[0])

    const malformedJsonChats = await Promise.all(targets.map(async ({ client }) => (
      responseSnapshot(await client.fetch('/api/chat-content/spool-char/0', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chat-id': 'malformed-json',
        },
        body: '{"message":',
      }))
    )))
    expect(malformedJsonChats[1]).toEqual(malformedJsonChats[0])
    expect(malformedJsonChats[2]).toEqual(malformedJsonChats[0])

    const genericKey = 'extension-defined/large-value'
    const genericPath = Buffer.from(genericKey).toString('hex')
    const genericBytes = Buffer.alloc(2 * 1024 * 1024 + 19, 0x5c)
    const genericWrites = await Promise.all(targets.map(async ({ client }) => responseSnapshot(
      await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': genericPath,
        },
        body: new Uint8Array(genericBytes),
      }),
    )))
    expect(genericWrites[1]).toEqual(genericWrites[0])
    expect(genericWrites[2]).toEqual(genericWrites[0])
    for (const { client } of targets) {
      const read = await client.fetch('/api/read', {
        headers: { 'file-path': genericPath },
      })
      expect(read.status).toBe(200)
      expect(Buffer.from(await read.arrayBuffer())).toEqual(genericBytes)
    }
    expect(await admittedArtifacts(current.server)).toEqual([])
    expect(await admittedArtifacts(degraded.server)).toEqual([])
  })

  test('a queued database publication rechecks ETag after validation', async () => {
    const gateDirName = 'write-gate'
    const { server, client } = await boot({
      POCKETRISU_TEST_ADMITTED_WRITE_GATE_DIR: gateDirName,
    })
    const baseline = {
      characters: [],
      botPresets: [],
      modules: [],
      personas: [],
      marker: 'baseline',
    }
    const baselineResponse = await writeDatabase(client, baseline)
    const baselineBody = await baselineResponse.json() as { etag: string }
    expect(baselineResponse.status).toBe(200)

    const gateDir = path.join(server.cwd, gateDirName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), 'hold')
    const racingWrite = writeDatabase(client, { ...baseline, marker: 'stale-spool' }, baselineBody.etag)
    await waitFor(path.join(gateDir, 'entered'))

    const spools = (await readdir(path.join(server.cwd, 'save', '.spool')))
      .filter(name => name.startsWith('.admitted-ingress-'))
    expect(spools).toHaveLength(1)
    expect((await stat(path.join(server.cwd, 'save', '.spool', spools[0]))).size)
      .toBe(encode({ ...baseline, marker: 'stale-spool' }).length)

    const patchedState = { ...baseline, patched: true }
    const patch = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(baseline)).toString(16),
        patch: [{ op: 'add', path: '/patched', value: true }],
      }),
    })
    expect(patch.status).toBe(200)
    const patchBody = await patch.json() as { etag: string }
    await writeFile(path.join(gateDir, 'release'), 'release')

    const conflict = await racingWrite
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toEqual({
      error: 'ETag mismatch - concurrent modification detected',
      currentEtag: patchBody.etag,
    })
    expect(calculateHash(normalizeJSON(patchedState)).toString(16)).not.toBe(
      calculateHash(normalizeJSON(baseline)).toString(16),
    )
    expect(await admittedArtifacts(server)).toEqual([])
  })

  test('startup removes only admitted-write stale artifacts', async () => {
    const server = await spawnServer({
      seedSave: async (saveDir) => {
        const spoolDir = path.join(saveDir, '.spool')
        await mkdir(path.join(spoolDir, '.admitted-write-stage-orphan'), { recursive: true })
        await writeFile(path.join(spoolDir, '.admitted-write-stage-orphan', 'row'), 'orphan')
        await writeFile(path.join(spoolDir, '.admitted-ingress-orphan.tmp'), 'orphan')
        await writeFile(path.join(spoolDir, 'unrelated.keep'), 'keep')
      },
    })
    servers.push(server)
    const entries = await readdir(path.join(server.cwd, 'save', '.spool'))
    expect(entries).not.toContain('.admitted-write-stage-orphan')
    expect(entries).not.toContain('.admitted-ingress-orphan.tmp')
    expect(entries).toContain('unrelated.keep')
  })

  test('refuses a compressed database whose declared input exceeds the existing ingress envelope', async () => {
    const { server, client } = await boot({ POCKETRISU_DATABASE_WRITE_MAX_BYTES: '512' })
    const body = encodeCompressed({
      characters: [],
      incompressible: randomBytes(2_048).toString('base64'),
    })
    expect(body.length).toBeGreaterThan(512)

    const response = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_PATH },
      body: new Uint8Array(body),
    })
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      error: 'Request body exceeds the 512-byte route limit.',
      code: 'BUFFERED_INGRESS_TOO_LARGE',
      limit: 512,
      actual: body.length,
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(await admittedArtifacts(server)).toEqual([])
  })

  test('refuses oversized compressed expansion with the restore preparation envelope', async () => {
    const decodedLimit = 64 * 1024
    const { server, client } = await boot({
      RISU_RESTORE_MAX_DECODED_BYTES: String(decodedLimit),
      RISU_RESTORE_DISK_HEADROOM_BYTES: '0',
    })
    const body = encodeCompressed({
      characters: [],
      padding: 'A'.repeat(decodedLimit * 3),
    })

    const response = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_PATH },
      body: new Uint8Array(body),
    })
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      error: `Decoded Risu save exceeds the safe preparation limit (${decodedLimit} bytes)`,
      code: 'RISU_SAVE_DECODED_TOO_LARGE',
      limit: decodedLimit,
      actual: expect.any(Number),
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(await admittedArtifacts(server)).toEqual([])
  })

  test('streams a valid expanded compressed database through admitted disk spools', async () => {
    const gateDirName = 'compressed-write-gate'
    const { server, client } = await boot({
      POCKETRISU_TEST_ADMITTED_WRITE_GATE_DIR: gateDirName,
      RISU_RESTORE_MAX_DECODED_BYTES: String(4 * 1024 * 1024),
      RISU_RESTORE_DISK_HEADROOM_BYTES: '0',
    })
    const database = {
      characters: [],
      botPresets: [],
      modules: [],
      personas: [],
      marker: 'streamed-compressed-write',
      padding: 'B'.repeat(2 * 1024 * 1024),
    }
    const body = encodeCompressed(database)
    const gateDir = path.join(server.cwd, gateDirName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), 'hold')

    const pending = client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_PATH },
      body: new Uint8Array(body),
    })
    await waitFor(path.join(gateDir, 'entered'))
    const ingressSpools = (await readdir(path.join(server.cwd, 'save', '.spool')))
      .filter(name => name.startsWith('.admitted-ingress-'))
    expect(ingressSpools).toHaveLength(1)
    expect((await stat(path.join(server.cwd, 'save', '.spool', ingressSpools[0]))).size)
      .toBe(body.length)
    await writeFile(path.join(gateDir, 'release'), 'release')

    const response = await pending
    expect(response.status).toBe(200)
    const stored = await client.fetch('/api/read', { headers: { 'file-path': DB_PATH } })
    expect(stored.status).toBe(200)
    const decoded = await decodeRisuSave(new Uint8Array(await stored.arrayBuffer()))
    expect(decoded).toMatchObject({
      marker: 'streamed-compressed-write',
      padding: database.padding,
    })
    expect(await admittedArtifacts(server)).toEqual([])

    const decoderSource = await readFile(
      path.resolve(import.meta.dirname, '../../server/node/utils.cjs'),
      'utf8',
    )
    expect(decoderSource).not.toContain('decompressSync')
    expect(decoderSource).not.toMatch(/Response\([^)]*readable[^)]*\)\.arrayBuffer\(\)/)
  }, 30_000)
})
