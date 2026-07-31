import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { readdir } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const PLUGIN_STORAGE_MANIFEST_KEY = 'plugin-storage/manifest.json'
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function pluginStorageKey(rawKey: string): string {
  return `pluginsave/${Buffer.from(rawKey, 'utf-8').toString('base64url')}.json`
}

function writeFixtureKvValue(cwd: string, key: string, value: Buffer): void {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    database.prepare(`
      INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    `).run(key, value, Date.now())
  } finally {
    database.close()
  }
}

function deleteFixtureKvValue(cwd: string, key: string): void {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    database.prepare('DELETE FROM kv WHERE key = ?').run(key)
  } finally {
    database.close()
  }
}

function encodeRisuSaveBlock(
  type: number,
  name: string,
  value: unknown,
  compression: boolean,
): Buffer {
  const nameBytes = Buffer.from(name, 'utf-8')
  const json = Buffer.from(JSON.stringify(value), 'utf-8')
  const body = compression ? gzipSync(json) : json
  const header = Buffer.alloc(7 + nameBytes.length)
  header[0] = type
  header[1] = compression ? 1 : 0
  header[2] = nameBytes.length
  nameBytes.copy(header, 3)
  header.writeUInt32LE(body.length, 3 + nameBytes.length)
  return Buffer.concat([header, body])
}

function missingChatBlockDatabase(compression: boolean): Buffer {
  return Buffer.concat([
    Buffer.from('RISUSAVE\0', 'utf-8'),
    encodeRisuSaveBlock(1, 'root', {
      optimizePluginMemory: false,
      personas: [],
      botPresetsId: 0,
      selectedCharacter: 0,
    }, compression),
    encodeRisuSaveBlock(4, 'preset', [], compression),
    encodeRisuSaveBlock(5, 'modules', [], compression),
    encodeRisuSaveBlock(9, 'plugins', [], compression),
    encodeRisuSaveBlock(11, 'pluginStorage', {}, compression),
    encodeRisuSaveBlock(2, 'missing-chat-character', {
      chaId: 'missing-chat-character',
      name: 'Damaged character',
      chats: [{ id: 'missing-chat', name: 'Missing', _stub: true }],
    }, compression),
    encodeRisuSaveBlock(0, 'config', { version: 1 }, compression),
  ])
}

async function expectArchiveExportRejected(
  client: RisuClient,
  target: 'nodeonly' | 'upstream' | 'main',
): Promise<void> {
  const query = target === 'nodeonly' ? '' : `?target=${target}`
  const response = await client.fetch(`/api/backup/export${query}`)
  expect(response.status).toBe(500)
  expect(response.headers.get('content-disposition')).toBeNull()
  expect(response.headers.get('x-risu-backup-assets')).toBeNull()
  expect(response.headers.get('content-type')).not.toContain('application/octet-stream')
  await response.arrayBuffer()
}

describe('full export corruption boundaries', () => {
  test.each([false, true])(
    'raw/gzip block exports reject a referenced missing chat row (gzip=%s)',
    async compression => {
      const server = await spawnServer()
      servers.push(server)
      const client = await createClient(server.port, server.password)
      writeFixtureKvValue(
        server.cwd,
        'database/database.bin',
        missingChatBlockDatabase(compression),
      )

      for (const target of ['nodeonly', 'upstream', 'main'] as const) {
        const response = await client.fetch(
          `/api/backup/export${target === 'nodeonly' ? '' : `?target=${target}`}`,
        )
        expect(response.status).toBe(500)
        expect(response.headers.get('content-disposition')).toBeNull()
        expect(response.headers.get('x-risu-backup-assets')).toBeNull()
        await expect(response.json()).resolves.toMatchObject({
          code: 'BACKUP_MISSING_CHAT_ROW',
        })
      }
      expect(await readdir(path.join(server.cwd, 'backups'))).toEqual([])
    },
    30_000,
  )

  test('rejects an unknown export target instead of silently creating a Node-only archive', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const response = await client.fetch('/api/backup/export?target=legacy-main')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'BACKUP_EXPORT_TARGET_INVALID',
    })
  })

  const publicationCorruptions = [
    {
      label: 'a missing declared row',
      corrupt(cwd: string, rowKey: string) {
        deleteFixtureKvValue(cwd, rowKey)
      },
    },
    {
      label: 'an invalid manifest',
      corrupt(cwd: string) {
        writeFixtureKvValue(cwd, PLUGIN_STORAGE_MANIFEST_KEY, Buffer.from('{'))
      },
    },
    {
      label: 'duplicate manifest declarations',
      corrupt(cwd: string, rowKey: string, generation: string) {
        writeFixtureKvValue(cwd, PLUGIN_STORAGE_MANIFEST_KEY, Buffer.from(JSON.stringify({
          version: 1,
          generation,
          valueKeys: [rowKey, rowKey],
          metaKeys: [],
        })))
      },
    },
    {
      label: 'a mismatched manifest generation',
      corrupt(cwd: string, rowKey: string) {
        writeFixtureKvValue(cwd, PLUGIN_STORAGE_MANIFEST_KEY, Buffer.from(JSON.stringify({
          version: 1,
          generation: 'foreign-generation',
          valueKeys: [rowKey],
          metaKeys: [],
        })))
      },
    },
  ]

  test.each(publicationCorruptions)(
    'generated optimized publication rejects $label before export or archive publication',
    async ({ corrupt }) => {
      const server = await spawnServer()
      servers.push(server)
      const client = await createClient(server.port, server.password)
      const generation = 'full-export-proof-generation'
      const rowKey = pluginStorageKey('owned-row')
      const manifest = {
        version: 1,
        generation,
        valueKeys: [rowKey],
        metaKeys: [],
      }
      const seed = Buffer.concat([
        createSeedBackup({
          databaseFields: {
            optimizePluginMemory: true,
            pluginStorageGeneration: generation,
            pluginCustomStorage: {},
          },
        }),
        encodeBackup([
          { name: rowKey, data: Buffer.from('{"owned":true}') },
          {
            name: PLUGIN_STORAGE_MANIFEST_KEY,
            data: Buffer.from(JSON.stringify(manifest)),
          },
        ]),
      ])
      expect(await client.importBackup(seed)).toMatchObject({ ok: true })
      corrupt(server.cwd, rowKey, generation)

      await expectArchiveExportRejected(client, 'nodeonly')
      await expectArchiveExportRejected(client, 'upstream')
      await expectArchiveExportRejected(client, 'main')

      const backupsDir = path.join(server.cwd, 'backups')
      const before = (await readdir(backupsDir)).sort()
      const saveResponse = await client.fetch('/api/backup/server/save', { method: 'POST' })
      expect(saveResponse.status).toBe(500)
      expect(saveResponse.headers.get('content-type')).not.toContain('application/x-ndjson')
      await saveResponse.arrayBuffer()
      expect((await readdir(backupsDir)).sort()).toEqual(before)
    },
    60_000,
  )
})
