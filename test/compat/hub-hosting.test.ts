import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnServer } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'

const DISABLED_ERROR = { error: 'Server backups are disabled on this instance' }

describe('hub hosting mode', () => {
  test('redacts host disk stats and disables file-based server backups', async () => {
    const server = await spawnServer({ env: { POCKETRISU_HUB_HOSTING: 'TRUE' } })
    try {
      const client = await createClient(server.port, server.password)

      const listResponse = await client.fetch('/api/backup/server/list')
      expect(listResponse.status).toBe(403)
      await expect(listResponse.json()).resolves.toEqual(DISABLED_ERROR)

      const statsResponse = await client.fetch('/api/db/stats')
      expect(statsResponse.status).toBe(200)
      const stats = await statsResponse.json() as Record<string, any>
      expect(stats.hubHosting).toBe(true)
      expect(stats.disk).toEqual({ free: null, total: null })
      expect(stats).not.toHaveProperty('backupDisk')
      expect(stats).not.toHaveProperty('estimatedBackupSize')
      expect(stats.backups.file).toEqual({ count: 0, totalSize: 0, oldest: null, newest: null })

      const reminderResponse = await client.fetch('/api/backup/boot-reminder')
      expect(reminderResponse.status).toBe(200)
      await expect(reminderResponse.json()).resolves.toEqual({ enabled: false })

      const saveResponse = await client.fetch('/api/backup/server/save', { method: 'POST' })
      expect(saveResponse.status).toBe(403)
      await expect(saveResponse.json()).resolves.toEqual(DISABLED_ERROR)

      for (const version of ['old', 'new']) {
        const chatWrite = await client.fetch('/api/chat-content/hub-char/0', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-chat-id': 'hub-chat' },
          body: JSON.stringify({
            id: 'hub-chat',
            name: version,
            message: [{ role: 'user', data: `${version} hub message` }],
          }),
        })
        expect(chatWrite.status).toBe(200)
      }
      const historyResponse = await client.fetch('/api/chat-backups/hub-char/hub-chat')
      expect(historyResponse.status).toBe(200)
      const history = await historyResponse.json() as { versions: Array<{ versionId: string }> }
      expect(history.versions).toHaveLength(1)
      const versionResponse = await client.fetch(
        `/api/chat-backups/hub-char/hub-chat/${history.versions[0].versionId}`,
      )
      expect(versionResponse.status).toBe(200)
      expect((await versionResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)
      expect(fs.existsSync(path.join(server.cwd, 'save', 'chat-backups'))).toBe(true)
      expect(fs.existsSync(path.join(server.cwd, 'backups', 'chat-backups'))).toBe(false)
      const statsAfterCapture = await (await client.fetch('/api/db/stats')).json() as Record<string, any>
      expect(statsAfterCapture.chatBackupFsBytes).toBeGreaterThan(0)
      expect(statsAfterCapture.chatBackupSameAsSaveDir).toBe(true)

      // Snapshot retention: the byte cap is pinned server-side (500 MB default
      // when POCKETRISU_HUB_SNAPSHOT_CAP_MB is unset); only count is tunable.
      const limitsBefore = await (await client.fetch('/api/db/snapshots/limits')).json() as Record<string, any>
      expect(limitsBefore.maxBytes).toBe(500 * 1024 * 1024)
      const limitsPut = await client.fetch('/api/db/snapshots/limits', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxCount: 25, maxBytes: 50 * 1024 * 1024 * 1024 }),
      })
      expect(limitsPut.status).toBe(200)
      const limitsAfter = await limitsPut.json() as Record<string, any>
      expect(limitsAfter.maxCount).toBe(25)
      expect(limitsAfter.maxBytes).toBe(500 * 1024 * 1024)
    } finally {
      await server.cleanup()
    }
  })

  test('honors POCKETRISU_HUB_SNAPSHOT_CAP_MB as the pinned snapshot byte cap', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_HUB_HOSTING: 'TRUE', POCKETRISU_HUB_SNAPSHOT_CAP_MB: '123' },
    })
    try {
      const client = await createClient(server.port, server.password)

      const limits = await (await client.fetch('/api/db/snapshots/limits')).json() as Record<string, any>
      expect(limits.maxBytes).toBe(123 * 1024 * 1024)

      const limitsPut = await client.fetch('/api/db/snapshots/limits', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxCount: 10, maxBytes: 50 * 1024 * 1024 * 1024 }),
      })
      expect(limitsPut.status).toBe(200)
      const limitsAfter = await limitsPut.json() as Record<string, any>
      expect(limitsAfter.maxCount).toBe(10)
      expect(limitsAfter.maxBytes).toBe(123 * 1024 * 1024)
    } finally {
      await server.cleanup()
    }
  })

  test('preserves server backups and reports hub hosting disabled by default', async () => {
    const server = await spawnServer()
    try {
      const client = await createClient(server.port, server.password)

      const statsResponse = await client.fetch('/api/db/stats')
      expect(statsResponse.status).toBe(200)
      const stats = await statsResponse.json() as Record<string, any>
      expect(stats.hubHosting).toBe(false)

      const listResponse = await client.fetch('/api/backup/server/list')
      expect(listResponse.status).toBe(200)
      await expect(listResponse.json()).resolves.toEqual({ backups: [] })
    } finally {
      await server.cleanup()
    }
  })
})
