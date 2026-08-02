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
const CHAT_DELTA_CONTENT_TYPE = 'application/vnd.pocketrisu.chat-delta+json'
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
  messageCount: number | null
  logSupported: number | null
  logCount: number
  logBytes: number
} | null {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = db.prepare(`
      SELECT content_sha256 AS contentHash,
             content_size AS contentSize,
             cold_storage AS coldStorage,
             message_count AS messageCount,
             log_supported AS logSupported,
             log_count AS logCount,
             log_bytes AS logBytes
        FROM chat_row_metadata
       WHERE row_key = ?
    `).get(key) as {
      contentHash: string | null
      contentSize: number | null
      coldStorage: number | null
      messageCount: number | null
      logSupported: number | null
      logCount: number
      logBytes: number
    } | undefined
    return row ?? null
  } finally {
    db.close()
  }
}

function operationLog(cwd: string, key: string): Array<{
  sequence: number
  baseHash: string
  resultHash: string
  patch: unknown
}> {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    return (db.prepare(`
      SELECT sequence, base_sha256 AS baseHash, result_sha256 AS resultHash, patch_json AS patch
        FROM chat_row_operations
       WHERE row_key = ?
       ORDER BY sequence
    `).all(key) as Array<any>).map(row => ({ ...row, patch: JSON.parse(row.patch) }))
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

  test('delta POST appends O(delta), acknowledges the logical digest, and GET/pre-image materialize exactly', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const base = {
      id: 'delta-chat',
      name: 'Delta chat',
      message: [{ role: 'user', data: 'base message' }],
      note: '',
      localLore: [],
    }
    const logical = {
      ...base,
      message: [
        { role: 'user', data: 'edited base message' },
        { role: 'char', data: 'streamed continuation' },
      ],
    }
    const baseBytes = encodeRisuDat(base)
    const logicalBytes = encodeRisuDat(logical)
    const baseHash = createHash('sha256').update(baseBytes).digest('hex')
    const logicalHash = createHash('sha256').update(logicalBytes).digest('hex')
    const rowKey = 'chats/delta-char/delta-chat'

    const fullResponse = await client.fetch('/api/chat-content/delta-char/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'delta-chat',
      },
      body: new Uint8Array(baseBytes),
    })
    expect(fullResponse.status).toBe(200)
    expect(await fullResponse.json()).toEqual({ success: true, hash: baseHash })

    const deltaPatch = [
      { op: 'replace', path: '/message/0', value: logical.message[0] },
      { op: 'add', path: '/message/-', value: logical.message[1] },
    ]
    const deltaResponse = await client.fetch('/api/chat-content/delta-char/0', {
      method: 'POST',
      headers: {
        'content-type': CHAT_DELTA_CONTENT_TYPE,
        'x-chat-id': 'delta-chat',
        'x-chat-backup-reason': 'streaming-checkpoint',
      },
      body: JSON.stringify({
        version: 1,
        baseHash,
        resultHash: logicalHash,
        resultSize: logicalBytes.length,
        patch: deltaPatch,
      }),
    })
    expect(deltaResponse.status).toBe(200)
    expect(await deltaResponse.json()).toEqual({
      success: true,
      hash: logicalHash,
      size: logicalBytes.length,
      log: {
        count: 1,
        bytes: Buffer.byteLength(JSON.stringify(deltaPatch)),
      },
    })
    // Until compaction, the protected KV value remains the byte-exact base.
    expect(rawKvRow(server.cwd, rowKey)).toEqual(baseBytes)
    expect(metadata(server.cwd, rowKey)).toMatchObject({
      contentHash: logicalHash,
      contentSize: logicalBytes.length,
      coldStorage: 0,
      messageCount: 2,
      logSupported: 1,
      logCount: 1,
    })
    expect(operationLog(server.cwd, rowKey)).toEqual([{
      sequence: 1,
      baseHash,
      resultHash: logicalHash,
      patch: deltaPatch,
    }])

    const getResponse = await client.fetch('/api/chat-content/delta-char/0', {
      headers: { 'x-chat-id': 'delta-chat' },
    })
    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get('x-content-hash')).toBe(logicalHash)
    expect(Buffer.from(await getResponse.arrayBuffer())).toEqual(logicalBytes)

    const historyResponse = await client.fetch('/api/chat-backups/delta-char/delta-chat')
    const history = await historyResponse.json() as {
      versions: Array<{ versionId: string; reason: string; size: number }>
    }
    expect(history.versions).toHaveLength(1)
    expect(history.versions[0]).toMatchObject({
      reason: 'streaming-checkpoint',
      size: baseBytes.length,
    })
    const preImageResponse = await client.fetch(
      `/api/chat-backups/delta-char/delta-chat/${history.versions[0].versionId}`,
    )
    expect(Buffer.from(await preImageResponse.arrayBuffer())).toEqual(baseBytes)
  })

  test('delta refusal envelopes are definitive and a full-row fallback remains byte-identical', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const base = { id: 'fallback-chat', message: [{ data: 'base' }] }
    const fallback = { id: 'fallback-chat', message: [{ data: 'full fallback' }] }
    const baseBytes = encodeRisuDat(base)
    const fallbackBytes = encodeRisuDat(fallback)
    const fallbackHash = createHash('sha256').update(fallbackBytes).digest('hex')
    await client.fetch('/api/chat-content/fallback-char/0', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-chat-id': 'fallback-chat' },
      body: new Uint8Array(baseBytes),
    })

    const staleResponse = await client.fetch('/api/chat-content/fallback-char/0', {
      method: 'POST',
      headers: { 'content-type': CHAT_DELTA_CONTENT_TYPE, 'x-chat-id': 'fallback-chat' },
      body: JSON.stringify({
        version: 1,
        baseHash: '0'.repeat(64),
        resultHash: fallbackHash,
        resultSize: fallbackBytes.length,
        patch: [{ op: 'replace', path: '/message/0', value: fallback.message[0] }],
      }),
    })
    expect(staleResponse.status).toBe(409)
    expect(await staleResponse.json()).toMatchObject({
      success: false,
      code: 'CHAT_DELTA_BASE_MISMATCH',
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
      currentHash: createHash('sha256').update(baseBytes).digest('hex'),
    })

    const malformedResponse = await client.fetch('/api/chat-content/fallback-char/0', {
      method: 'POST',
      headers: { 'content-type': CHAT_DELTA_CONTENT_TYPE, 'x-chat-id': 'fallback-chat' },
      body: JSON.stringify({ version: 1, unexpected: true }),
    })
    expect(malformedResponse.status).toBe(400)
    expect(await malformedResponse.json()).toMatchObject({
      code: 'CHAT_DELTA_INVALID',
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const fallbackResponse = await client.fetch('/api/chat-content/fallback-char/0', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-chat-id': 'fallback-chat' },
      body: new Uint8Array(fallbackBytes),
    })
    expect(await fallbackResponse.json()).toEqual({ success: true, hash: fallbackHash })
    expect(operationLog(server.cwd, 'chats/fallback-char/fallback-chat')).toEqual([])
    const get = await client.fetch('/api/chat-content/fallback-char/0', {
      headers: { 'x-chat-id': 'fallback-chat' },
    })
    expect(Buffer.from(await get.arrayBuffer())).toEqual(fallbackBytes)
  })

  test('queued threshold compaction atomically retains the logical row and clears applied entries', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_CHAT_DELTA_COMPACT_MAX_OPERATIONS: '2' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const versions = [
      { id: 'compact-chat', message: [{ data: 'zero' }] },
      { id: 'compact-chat', message: [{ data: 'one' }] },
      { id: 'compact-chat', message: [{ data: 'two' }] },
    ]
    const encoded = versions.map(encodeRisuDat)
    const hashes = encoded.map(bytes => createHash('sha256').update(bytes).digest('hex'))
    await client.fetch('/api/chat-content/compact-char/0', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-chat-id': 'compact-chat' },
      body: new Uint8Array(encoded[0]),
    })
    for (let index = 1; index < versions.length; index++) {
      const response = await client.fetch('/api/chat-content/compact-char/0', {
        method: 'POST',
        headers: { 'content-type': CHAT_DELTA_CONTENT_TYPE, 'x-chat-id': 'compact-chat' },
        body: JSON.stringify({
          version: 1,
          baseHash: hashes[index - 1],
          resultHash: hashes[index],
          resultSize: encoded[index].length,
          patch: [{ op: 'replace', path: '/message/0', value: versions[index].message[0] }],
        }),
      })
      expect(response.status).toBe(200)
    }

    const key = 'chats/compact-char/compact-chat'
    await expect.poll(() => operationLog(server.cwd, key).length, { timeout: 5_000 }).toBe(0)
    expect(rawKvRow(server.cwd, key)).toEqual(encoded[2])
    expect(metadata(server.cwd, key)).toMatchObject({
      contentHash: hashes[2],
      contentSize: encoded[2].length,
      logCount: 0,
      logBytes: 0,
    })
    const get = await client.fetch('/api/chat-content/compact-char/0', {
      headers: { 'x-chat-id': 'compact-chat' },
    })
    expect(Buffer.from(await get.arrayBuffer())).toEqual(encoded[2])
  })

  test('POST overwrite history returns the byte-exact streamed pre-image', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const first = encodeRisuDat({
      id: 'pre-image-chat',
      name: 'First state',
      message: [{ role: 'user', data: 'byte-exact first state' }],
    })
    const second = encodeRisuDat({
      id: 'pre-image-chat',
      name: 'Second state',
      message: [{ role: 'user', data: 'replacement state' }],
    })
    for (const bytes of [first, second]) {
      const response = await client.fetch('/api/chat-content/pre-image-char/0', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-chat-id': 'pre-image-chat',
          'x-chat-backup-reason': 'edit-message',
        },
        body: new Uint8Array(bytes),
      })
      expect(response.status).toBe(200)
    }

    const historyResponse = await client.fetch(
      '/api/chat-backups/pre-image-char/pre-image-chat',
    )
    expect(historyResponse.status).toBe(200)
    const history = await historyResponse.json() as {
      versions: Array<{ versionId: string; reason: string; size: number }>
    }
    expect(history.versions).toHaveLength(1)
    expect(history.versions[0]).toMatchObject({ reason: 'edit-message', size: first.length })

    const versionResponse = await client.fetch(
      `/api/chat-backups/pre-image-char/pre-image-chat/${history.versions[0].versionId}`,
    )
    expect(versionResponse.status).toBe(200)
    expect(Buffer.from(await versionResponse.arrayBuffer())).toEqual(first)
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
