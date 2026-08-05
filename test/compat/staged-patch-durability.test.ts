import { afterAll, describe, expect, test } from 'vitest'
import { Packr } from 'msgpackr'
import utilsPkg from '../../server/node/utils.cjs'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false, variableMapSize: true })
const DB_KEY = 'database/database.bin'
const DB_PATH_HEX = Buffer.from(DB_KEY, 'utf8').toString('hex')
const { calculateHash, normalizeJSON } = utilsPkg as {
  calculateHash: (value: unknown) => number
  normalizeJSON: (value: unknown) => Record<string, any>
}
const servers: ServerHandle[] = []

interface WriterSession {
  id: string
  epoch: string
  cookie: string
}

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeRisuDat(value: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

function initialDatabase() {
  return {
    characters: [{
      chaId: 'durability-character',
      name: 'Original character name',
      chats: [],
      chatPage: 0,
    }],
    apiType: 'openai',
    personas: [],
    botPresets: [],
    botPresetsId: 0,
    selectedCharacter: 0,
  }
}

async function registerSession(client: RisuClient, id: string): Promise<WriterSession> {
  const response = await client.fetch('/api/session', {
    method: 'POST',
    headers: { 'x-session-id': id },
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { writerEpoch?: unknown }
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  expect(typeof body.writerEpoch).toBe('string')
  expect(cookie).toBeTruthy()
  return { id, epoch: body.writerEpoch as string, cookie: cookie! }
}

function writerHeaders(session: WriterSession): Record<string, string> {
  return {
    'x-session-id': session.id,
    'x-writer-epoch': session.epoch,
  }
}

async function writeDatabase(
  client: RisuClient,
  session: WriterSession,
  database: Record<string, unknown>,
): Promise<void> {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': DB_PATH_HEX,
      ...writerHeaders(session),
    },
    body: new Uint8Array(encodeRisuDat(database)),
  })
  expect(response.status).toBe(200)
}

async function readDatabase(client: RisuClient): Promise<Record<string, any>> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': DB_PATH_HEX },
  })
  expect(response.status).toBe(200)
  return decodeRisuDat(Buffer.from(await response.arrayBuffer())) as Record<string, any>
}

function patchDatabase(
  client: RisuClient,
  session: WriterSession,
  baseline: Record<string, any>,
  patch: Array<Record<string, unknown>>,
): Promise<Response> {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'file-path': DB_PATH_HEX,
      ...writerHeaders(session),
    },
    body: JSON.stringify({
      expectedHash: calculateHash(normalizeJSON(baseline)).toString(16),
      patch,
    }),
  })
}

async function flushDatabase(
  client: RisuClient,
  session: WriterSession,
): Promise<Record<string, any>> {
  const response = await client.fetch('/api/db/flush', {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      ...writerHeaders(session),
    },
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<Record<string, any>>
}

describe('staged patch durability', () => {
  test('a new chat stub is durable before its patch acknowledgement', async () => {
    const server = await spawnServer()
    servers.push(server)
    let client = await createClient(server.port, server.password)
    const session = await registerSession(client, 'structural-writer')
    await writeDatabase(client, session, initialDatabase())
    const baseline = await readDatabase(client)
    const chat = {
      id: 'durable-new-chat',
      name: 'Durable new chat',
      message: [{ role: 'user', data: 'survives an immediate process kill' }],
      note: '',
      localLore: [],
    }

    const chatWrite = await client.fetch('/api/chat-content/durability-character/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': chat.id,
        ...writerHeaders(session),
      },
      body: new Uint8Array(encodeRisuDat(chat)),
    })
    expect(chatWrite.status).toBe(200)

    const stub = { id: chat.id, name: chat.name, _stub: true }
    const patchResponse = await patchDatabase(client, session, baseline, [{
      op: 'add',
      path: '/characters/0/chats/0',
      value: stub,
    }])
    expect(patchResponse.status).toBe(200)
    await expect(patchResponse.json()).resolves.toMatchObject({
      success: true,
      durable: true,
    })

    await server.crash()
    await server.restart()
    client = await createClient(server.port, server.password)

    const restarted = await readDatabase(client)
    expect(restarted.characters[0].chats).toContainEqual(expect.objectContaining(stub))
    const chatRead = await client.fetch('/api/chat-content/durability-character/0', {
      headers: { 'x-chat-id': chat.id },
    })
    expect(chatRead.status).toBe(200)
    expect(decodeRisuDat(Buffer.from(await chatRead.arrayBuffer()))).toMatchObject(chat)
  })

  test('a non-structural patch stays staged until an explicit durable flush', async () => {
    const server = await spawnServer()
    servers.push(server)
    let client = await createClient(server.port, server.password)
    let session = await registerSession(client, 'staged-writer-before-crash')
    await writeDatabase(client, session, initialDatabase())
    let baseline = await readDatabase(client)
    const renamed = 'Name committed only after flush'

    const staged = await patchDatabase(client, session, baseline, [{
      op: 'replace',
      path: '/characters/0/name',
      value: renamed,
    }])
    expect(staged.status).toBe(200)
    await expect(staged.json()).resolves.toMatchObject({
      success: true,
      durable: false,
    })

    await server.crash()
    await server.restart()
    client = await createClient(server.port, server.password)
    baseline = await readDatabase(client)
    expect(baseline.characters[0].name).toBe('Original character name')

    session = await registerSession(client, 'staged-writer-after-crash')
    const stagedAgain = await patchDatabase(client, session, baseline, [{
      op: 'replace',
      path: '/characters/0/name',
      value: renamed,
    }])
    expect(stagedAgain.status).toBe(200)
    await expect(stagedAgain.json()).resolves.toMatchObject({ durable: false })
    await expect(flushDatabase(client, session)).resolves.toMatchObject({
      success: true,
      durable: true,
    })

    await server.crash()
    await server.restart()
    client = await createClient(server.port, server.password)
    expect((await readDatabase(client)).characters[0].name).toBe(renamed)
  })
})
