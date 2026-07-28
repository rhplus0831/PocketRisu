import { describe, expect, test } from 'vitest'
import { createSeedBackup } from './helpers/seed.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer } from './helpers/spawnServer.js'

type DurabilityMode = 'durable' | 'balanced' | 'performance'

interface DurabilityState {
  mode: DurabilityMode
  managed: boolean
  managedBy: 'environment' | 'hub' | null
  synchronous: 'FULL' | 'NORMAL'
  checkpointIntervalMs: number | null
  powerLossWindowMs: number
}

async function createSessionCookie(client: RisuClient): Promise<string> {
  const response = await client.fetch('/api/session', { method: 'POST' })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('session setup returned no cookie')
  return cookie
}

async function readDurability(client: RisuClient): Promise<DurabilityState> {
  const response = await client.fetch('/api/db/durability')
  expect(response.status).toBe(200)
  return response.json() as Promise<DurabilityState>
}

async function setDurability(
  client: RisuClient,
  mode: DurabilityMode,
): Promise<{ response: Response; state: DurabilityState }> {
  const response = await client.fetch('/api/db/durability', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  return {
    response,
    state: await response.json() as DurabilityState,
  }
}

describe('SQLite durability policy', () => {
  test('defaults to FULL and makes explicit flush a verified durability boundary', async () => {
    const server = await spawnServer()
    try {
      const client = await createClient(server.port, server.password)
      const state = await readDurability(client)
      expect(state).toMatchObject({
        mode: 'durable',
        managed: false,
        managedBy: null,
        synchronous: 'FULL',
        checkpointIntervalMs: null,
        powerLossWindowMs: 0,
      })

      const stats = await (await client.fetch('/api/db/stats')).json() as Record<string, any>
      expect(stats.sqlite.synchronous).toBe(2)

      const cookie = await createSessionCookie(client)
      const key = 'test/sqlite-durability'
      const write = await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': Buffer.from(key, 'utf-8').toString('hex'),
        },
        body: new Uint8Array(Buffer.from('durable value', 'utf-8')),
      })
      expect(write.status).toBe(200)

      const flush = await client.fetch('/api/db/flush', {
        method: 'POST',
        headers: { cookie },
      })
      expect(flush.status).toBe(200)
      await expect(flush.json()).resolves.toMatchObject({
        success: true,
        durable: true,
        checkpoint: {
          mode: 'FULL',
          reason: 'explicit-flush',
          complete: true,
          busy: 0,
        },
      })
    } finally {
      await server.cleanup()
    }
  })

  test('persists an explicit balanced choice and restores it after import and restart', async () => {
    const server = await spawnServer()
    try {
      let client = await createClient(server.port, server.password)
      const changed = await setDurability(client, 'balanced')
      expect(changed.response.status).toBe(200)
      expect(changed.state).toMatchObject({
        mode: 'balanced',
        managed: false,
        synchronous: 'NORMAL',
        checkpointIntervalMs: 60_000,
        powerLossWindowMs: 60_000,
      })

      const cookie = await createSessionCookie(client)
      const write = await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': Buffer.from('test/balanced-flush', 'utf-8').toString('hex'),
        },
        body: new Uint8Array(Buffer.from('checkpoint me', 'utf-8')),
      })
      expect(write.status).toBe(200)
      const flush = await client.fetch('/api/db/flush', {
        method: 'POST',
        headers: { cookie },
      })
      expect(flush.status).toBe(200)
      await expect(flush.json()).resolves.toMatchObject({
        success: true,
        durable: true,
        checkpoint: { mode: 'FULL', complete: true, busy: 0 },
      })

      expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
      expect(await readDurability(client)).toMatchObject({
        mode: 'balanced',
        synchronous: 'NORMAL',
      })
      const statsAfterImport = await (await client.fetch('/api/db/stats')).json() as Record<string, any>
      expect(statsAfterImport.sqlite.synchronous).toBe(1)

      await server.restart()
      client = await createClient(server.port, server.password)
      expect(await readDurability(client)).toMatchObject({
        mode: 'balanced',
        managed: false,
        synchronous: 'NORMAL',
        checkpointIntervalMs: 60_000,
      })
    } finally {
      await server.cleanup()
    }
  })

  test('lets a hub administrator select a mode through the environment and blocks tenant changes', async () => {
    const server = await spawnServer({
      env: {
        POCKETRISU_HUB_HOSTING: 'TRUE',
        POCKETRISU_SQLITE_DURABILITY_MODE: 'performance',
      },
      createBackupsDir: false,
    })
    try {
      const client = await createClient(server.port, server.password)
      expect(await readDurability(client)).toMatchObject({
        mode: 'performance',
        managed: true,
        managedBy: 'environment',
        synchronous: 'NORMAL',
        checkpointIntervalMs: 300_000,
        powerLossWindowMs: 300_000,
      })

      const changed = await setDurability(client, 'durable')
      expect(changed.response.status).toBe(403)
      expect(changed.state).toMatchObject({
        mode: 'performance',
        managed: true,
        synchronous: 'NORMAL',
      })
    } finally {
      await server.cleanup()
    }
  })
})
