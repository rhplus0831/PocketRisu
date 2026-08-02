import { afterAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01'
const packr = new Packr({ useRecords: false, variableMapSize: true })
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeRisuDat(value: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

function chatRowKey(chatId: string): string {
  return `chats/chat-content-char/${chatId}`
}

function buildChatBackup(revision: string): {
  backup: Buffer
  warm: Record<string, unknown>
  legacy: Record<string, unknown>
} {
  const warm = {
    id: 'warm-chat',
    name: 'Warm chat',
    message: [{ role: 'user', data: `warm-${revision}` }],
    note: '',
    localLore: [],
  }
  const legacy = {
    id: 'legacy-chat',
    name: 'Legacy metadata gap',
    message: [{ role: 'user', data: `legacy-${revision}` }],
    note: '',
    localLore: [],
  }
  const cold = {
    id: 'cold-chat',
    name: 'Cold chat',
    message: [{ role: 'user', data: `${COLD_STORAGE_HEADER}cold-chat-key` }],
    note: '',
    localLore: [],
  }
  const database = {
    characters: [{
      chaId: 'chat-content-char',
      name: 'Chat content character',
      chats: [warm, cold, legacy],
      chatPage: 0,
    }],
    apiType: 'openai',
    personas: [],
    botPresets: [],
    botPresetsId: 0,
    selectedCharacter: 0,
  }
  return {
    backup: encodeBackup([
      { name: 'database.risudat', data: encodeRisuDat(database) },
      {
        name: 'coldstorage/cold-chat-key.json',
        data: Buffer.from(JSON.stringify({
          message: [{ role: 'char', data: `restored-${revision}` }],
          scriptstate: { revision },
          localLore: [],
        })),
      },
    ]),
    warm,
    legacy,
  }
}

function metadata(cwd: string, key: string): {
  contentHash: string | null
  contentSize: number | null
  coldStorage: number | null
} | null {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = db.prepare(`
      SELECT content_sha256 AS contentHash,
             content_size AS contentSize,
             cold_storage AS coldStorage
        FROM chat_row_metadata
       WHERE row_key = ?
    `).get(key) as {
      contentHash: string | null
      contentSize: number | null
      coldStorage: number | null
    } | undefined
    return row ?? null
  } finally {
    db.close()
  }
}

function rawKvRow(cwd: string, key: string): Buffer | null {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as {
      value: Buffer
    } | undefined
    return row ? Buffer.from(row.value) : null
  } finally {
    db.close()
  }
}

function removeMetadata(cwd: string, key: string): void {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    db.prepare('DELETE FROM chat_row_metadata WHERE row_key = ?').run(key)
  } finally {
    db.close()
  }
}

async function getChat(
  client: Awaited<ReturnType<typeof createClient>>,
  index: number,
  chatId: string,
): Promise<{ response: Response; bytes: Buffer }> {
  const response = await client.fetch(`/api/chat-content/chat-content-char/${index}`, {
    headers: { 'x-chat-id': chatId },
  })
  return { response, bytes: Buffer.from(await response.arrayBuffer()) }
}

describe('chat content row serving', () => {
  test('warm, cold, and missing-metadata rows preserve bytes and repair lazily after restore', async () => {
    const server = await spawnServer()
    servers.push(server)
    let client = await createClient(server.port, server.password)
    const first = buildChatBackup('v1')
    expect((await client.importBackup(first.backup)).ok).toBe(true)

    const restored = buildChatBackup('v2')
    expect((await client.importBackup(restored.backup)).ok).toBe(true)
    expect(metadata(server.cwd, chatRowKey('cold-chat'))?.coldStorage).toBe(1)
    const restoredLegacyMeta = metadata(server.cwd, chatRowKey('legacy-chat'))
    expect(restoredLegacyMeta?.contentHash).toMatch(/^[0-9a-f]{64}$/)

    await server.crash()
    removeMetadata(server.cwd, chatRowKey('legacy-chat'))
    await server.restart()
    client = await createClient(server.port, server.password)

    const warm = await getChat(client, 0, 'warm-chat')
    const expectedWarm = encodeRisuDat(restored.warm)
    expect(warm.response.status).toBe(200)
    expect(warm.bytes).toEqual(expectedWarm)
    expect(warm.response.headers.get('x-content-hash')).toBe(
      createHash('sha256').update(expectedWarm).digest('hex'),
    )

    const legacy = await getChat(client, 2, 'legacy-chat')
    const expectedLegacy = encodeRisuDat(restored.legacy)
    expect(legacy.response.status).toBe(200)
    expect(legacy.bytes).toEqual(expectedLegacy)
    expect(metadata(server.cwd, chatRowKey('legacy-chat'))).toMatchObject({
      contentHash: createHash('sha256').update(expectedLegacy).digest('hex'),
      contentSize: expectedLegacy.length,
      coldStorage: 0,
    })

    const cold = await getChat(client, 1, 'cold-chat')
    expect(cold.response.status).toBe(200)
    expect((decodeRisuDat(cold.bytes) as any).message).toEqual([
      { role: 'char', data: 'restored-v2' },
    ])
    // The historical route cache-filled exactly the bytes it returned.
    expect(rawKvRow(server.cwd, chatRowKey('cold-chat'))).toEqual(cold.bytes)
    expect(cold.response.headers.get('x-content-hash')).toBe(
      createHash('sha256').update(cold.bytes).digest('hex'),
    )
    expect(metadata(server.cwd, chatRowKey('cold-chat'))?.coldStorage).toBe(0)
  })

  test('POST acknowledges the written bytes without a committed-row reread', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const bytes = encodeRisuDat({
      id: 'post-chat',
      name: 'POST chat',
      message: [{ role: 'user', data: 'owned request bytes' }],
    })
    const response = await client.fetch('/api/chat-content/post-char/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'post-chat',
      },
      body: new Uint8Array(bytes),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      hash: createHash('sha256').update(bytes).digest('hex'),
    })

    const source = readFileSync(
      new URL('../../server/node/server.cjs', import.meta.url),
      'utf-8',
    )
    const routeStart = source.indexOf("app.post('/api/chat-content/:chaId/:chatIndex'")
    const routeEnd = source.indexOf('// ── Save-folder migration endpoints', routeStart)
    expect(routeStart).toBeGreaterThanOrEqual(0)
    expect(routeEnd).toBeGreaterThan(routeStart)
    const route = source.slice(routeStart, routeEnd)
    expect(route).toContain('writeChatRowRawOwned')
    expect(route).not.toContain('readChatRowRaw(')
    expect(route).not.toContain('Stored chat row could not be read')
  })

  test('GET selects one raw row and never calls the decoded row reader on its warm path', () => {
    const source = readFileSync(
      new URL('../../server/node/server.cjs', import.meta.url),
      'utf-8',
    )
    const routeStart = source.indexOf("app.get('/api/chat-content/:chaId/:chatIndex'")
    const routeEnd = source.indexOf('// POST /api/chat-content', routeStart)
    expect(routeStart).toBeGreaterThanOrEqual(0)
    expect(routeEnd).toBeGreaterThan(routeStart)
    const route = source.slice(routeStart, routeEnd)
    expect(route).toContain('readChatRowRawWithMetadata')
    expect(route).not.toContain('readChatRow(')
    expect(route).not.toContain('readChatRowRaw(')
  })

  test('production pre-image capture publishes from the protected-row stream', () => {
    const serverSource = readFileSync(
      new URL('../../server/node/server.cjs', import.meta.url),
      'utf-8',
    )
    const storeStart = serverSource.indexOf('const chatBackupStore = createChatBackupStore({')
    const storeEnd = serverSource.indexOf('});', storeStart)
    expect(storeStart).toBeGreaterThanOrEqual(0)
    expect(storeEnd).toBeGreaterThan(storeStart)
    expect(serverSource.slice(storeStart, storeEnd)).toContain('streamChatRowRawToFile')

    const backupSource = readFileSync(
      new URL('../../server/node/chatBackups.cjs', import.meta.url),
      'utf-8',
    )
    const captureStart = backupSource.indexOf('async function captureChatPreImage')
    const captureEnd = backupSource.indexOf('function cleanupStaleTemps', captureStart)
    expect(captureStart).toBeGreaterThanOrEqual(0)
    expect(captureEnd).toBeGreaterThan(captureStart)
    const capture = backupSource.slice(captureStart, captureEnd)
    expect(capture).toContain('writeFileAtomicFromSource')
    expect(capture).toContain('streamRowToFile')
    expect(capture).not.toContain('Buffer.from(existing)')
    expect(capture).not.toMatch(/writeFileAtomic\([^)]*,\s*raw\s*\)/)
  })
})
