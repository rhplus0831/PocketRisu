import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

interface CleanupResult {
  ok: boolean
  skipped: boolean
  assets: number
  referenced: number
  marked: number
  retainedByGrace: number
  deleted: number
}

function assetFixture(label: string) {
  const bytes = Buffer.from(`asset-gc:${label}`, 'utf-8')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const name = `${hash}.png`
  return { bytes, key: `assets/${name}`, name }
}

async function writeAsset(client: RisuClient, key: string, bytes: Buffer) {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(key, 'utf-8').toString('hex'),
    },
    body: new Uint8Array(bytes),
  })
  expect(response.status).toBe(200)
}

async function cleanup(client: RisuClient): Promise<CleanupResult> {
  const response = await client.fetch('/api/assets/cleanup', { method: 'POST' })
  expect(response.status).toBe(200)
  return response.json() as Promise<CleanupResult>
}

async function bootWithDatabase(
  databaseFields: Record<string, unknown>,
): Promise<{ server: ServerHandle; client: RisuClient }> {
  const server = await spawnServer({
    env: {
      POCKETRISU_ASSET_GC_GRACE_MS: '0',
      POCKETRISU_ASSET_GC_AUTO: '0',
    },
  })
  const client = await createClient(server.port, server.password)
  const imported = await client.importBackup(createSeedBackup({ databaseFields }))
  expect(imported.ok).toBe(true)
  return { server, client }
}

describe('server-owned asset garbage collection', () => {
  test.each([
    ['inline', false],
    ['optimized', true],
  ])('keeps plugin-only assets referenced by %s storage', async (_label, optimized) => {
    const fixture = assetFixture(`plugin-${optimized}`)
    const { server, client } = await bootWithDatabase({
      optimizePluginMemory: optimized,
      pluginCustomStorage: {
        pluginAsset: {
          nested: `preview(${fixture.key})`,
        },
      },
    })
    try {
      await writeAsset(client, fixture.key, fixture.bytes)
      const first = await cleanup(client)
      const second = await cleanup(client)

      expect(first).toMatchObject({ referenced: 1, marked: 0, deleted: 0 })
      expect(second).toMatchObject({ referenced: 1, marked: 0, deleted: 0 })
      expect(existsSync(path.join(server.cwd, 'save', 'assets', fixture.name))).toBe(true)

      const statsResponse = await client.fetch('/api/db/stats/characters')
      expect(statsResponse.status).toBe(200)
      const stats = await statsResponse.json() as { orphan: { count: number } }
      expect(stats.orphan).toMatchObject({ count: 0 })
    } finally {
      await server.cleanup()
    }
  })

  test('marks a true orphan before deleting it on a later grace-qualified pass', async () => {
    const fixture = assetFixture('orphan')
    const { server, client } = await bootWithDatabase({ pluginCustomStorage: {} })
    try {
      await writeAsset(client, fixture.key, fixture.bytes)

      expect(await cleanup(client)).toMatchObject({
        referenced: 0,
        marked: 1,
        retainedByGrace: 1,
        deleted: 0,
      })
      expect(existsSync(path.join(server.cwd, 'save', 'assets', fixture.name))).toBe(true)

      // Re-publishing the same content-addressed bytes is a no-op at the file
      // layer, but it must still clear the old GC candidate and restart grace.
      await writeAsset(client, fixture.key, fixture.bytes)
      expect(await cleanup(client)).toMatchObject({
        referenced: 0,
        marked: 1,
        retainedByGrace: 1,
        deleted: 0,
      })
      expect(existsSync(path.join(server.cwd, 'save', 'assets', fixture.name))).toBe(true)

      expect(await cleanup(client)).toMatchObject({
        referenced: 0,
        marked: 0,
        deleted: 1,
      })
      expect(existsSync(path.join(server.cwd, 'save', 'assets', fixture.name))).toBe(false)
    } finally {
      await server.cleanup()
    }
  })

  test('fails closed before deleting when an active optimized plugin row is invalid', async () => {
    const fixture = assetFixture('fail-closed')
    const { server, client } = await bootWithDatabase({
      optimizePluginMemory: true,
      pluginCustomStorage: { ordinaryValue: { safe: true } },
    })
    try {
      await writeAsset(client, fixture.key, fixture.bytes)
      expect(await cleanup(client)).toMatchObject({ marked: 1, deleted: 0 })

      const database = new Database(path.join(server.cwd, 'save', 'risuai.db'))
      try {
        const row = database.prepare(
          `SELECT key FROM kv WHERE key LIKE 'pluginsave/%' ORDER BY key LIMIT 1`,
        ).get() as { key: string } | undefined
        expect(row).toBeDefined()
        database.prepare('UPDATE kv SET value = ? WHERE key = ?')
          .run(Buffer.from('{invalid json', 'utf-8'), row!.key)
      } finally {
        database.close()
      }

      const failed = await client.fetch('/api/assets/cleanup', { method: 'POST' })
      expect(failed.status).toBe(400)
      await expect(failed.json()).resolves.toMatchObject({ code: 'INVALID_PLUGIN_STORAGE_ROW' })
      expect(existsSync(path.join(server.cwd, 'save', 'assets', fixture.name))).toBe(true)
    } finally {
      await server.cleanup()
    }
  })
})
