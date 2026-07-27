import path from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient } from './helpers/client.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { Packr } from 'msgpackr'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeRisuDat(database: Record<string, unknown>): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(database))])
}

function readKvRows(cwd: string, prefix: string): Array<{ key: string; value: Buffer }> {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    return (database.prepare(
      'SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key',
    ).all(`${prefix}%`) as Array<{ key: string; value: Buffer }>).map(row => ({
      key: row.key,
      value: Buffer.from(row.value),
    }))
  } finally {
    database.close()
  }
}

describe('backup missing chat-row integrity', () => {
  test('full download and server save both reject a missing authoritative chat row', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const chaId = 'damaged-character'
    const chatId = 'missing-chat'
    const damagedDatabase = encodeRisuDat({
      characters: [{
        chaId,
        name: 'Damaged character',
        chats: [{ id: chatId, name: 'Lost chat', _stub: true }],
      }],
    })

    const writeResponse = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex'),
      },
      body: new Uint8Array(damagedDatabase),
    })
    expect(writeResponse.status).toBe(200)

    const snapshots = readKvRows(server.cwd, 'database/dbbackup-')
    expect(snapshots).toHaveLength(1)
    expect(decodeRisuDat(snapshots[0].value).characters[0].chats[0]).toEqual(
      expect.objectContaining({ id: chatId, _stub: true }),
    )

    const exportResponse = await client.fetch('/api/backup/export')
    expect(exportResponse.status).toBe(500)
    expect(exportResponse.headers.get('content-disposition')).toBeNull()
    await expect(exportResponse.json()).resolves.toMatchObject({
      code: 'BACKUP_MISSING_CHAT_ROW',
      error: expect.stringContaining(`${chaId}/${chatId}`),
    })

    const serverSaveResponse = await client.fetch('/api/backup/server/save', { method: 'POST' })
    expect(serverSaveResponse.status).toBe(500)
    await expect(serverSaveResponse.json()).resolves.toMatchObject({
      code: 'BACKUP_MISSING_CHAT_ROW',
      error: expect.stringContaining(`${chaId}/${chatId}`),
    })
  })
})
