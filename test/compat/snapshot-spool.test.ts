import { afterAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodeDatabase(revision: string): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode({
    characters: [],
    apiType: 'openai',
    personas: [],
    botPresets: [],
    botPresetsId: 0,
    selectedCharacter: 0,
    snapshotSpoolRevision: revision,
  }))])
}

function writeDatabase(client: RisuClient, revision: string): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': DB_BLOB_HEX,
    },
    body: new Uint8Array(encodeDatabase(revision)),
  })
}

async function listSnapshots(client: RisuClient): Promise<Array<{ key: string }>> {
  const response = await client.fetch('/api/db/snapshots')
  expect(response.status).toBe(200)
  return ((await response.json()) as { snapshots: Array<{ key: string }> }).snapshots
}

describe('database snapshot spool isolation', () => {
  test('hub writes snapshot through save/.spool without a backups directory', async () => {
    const orphanName = '.database-risudat-crash-orphan.tmp'
    const server = await spawnServer({
      createBackupsDir: false,
      env: {
        POCKETRISU_HUB_HOSTING: 'TRUE',
        POCKETRISU_BACKUP_INTERVAL_MS: '0',
      },
      seedSave: async (saveDir) => {
        const spoolDir = path.join(saveDir, '.spool')
        await mkdir(spoolDir, { recursive: true })
        await writeFile(path.join(spoolDir, orphanName), 'orphan')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect(existsSync(path.join(server.cwd, 'backups'))).toBe(false)
    expect(existsSync(path.join(server.cwd, 'save', '.spool'))).toBe(true)
    expect(existsSync(path.join(server.cwd, 'save', '.spool', orphanName))).toBe(false)

    expect((await writeDatabase(client, 'hub-write')).status).toBe(200)
    expect(await listSnapshots(client)).toHaveLength(1)
    expect(existsSync(path.join(server.cwd, 'backups'))).toBe(false)
  })

  test('failed spool does not fail writes or consume the snapshot cooldown', async () => {
    const spoolPath = path.join('save', 'blocked-spool')
    const server = await spawnServer({
      env: {
        POCKETRISU_SPOOL_DIR: spoolPath,
        POCKETRISU_BACKUP_INTERVAL_MS: '3600000',
      },
      seedSave: async (saveDir) => {
        await writeFile(path.join(saveDir, 'blocked-spool'), 'not a directory')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect((await writeDatabase(client, 'blocked')).status).toBe(200)
    expect(await listSnapshots(client)).toHaveLength(0)

    const failedExport = await client.fetch('/api/backup/export')
    expect(failedExport.status).toBe(500)

    const absoluteSpoolPath = path.join(server.cwd, spoolPath)
    await rm(absoluteSpoolPath)
    await mkdir(absoluteSpoolPath)

    expect((await writeDatabase(client, 'recovered')).status).toBe(200)
    expect(await listSnapshots(client)).toHaveLength(1)
  })
})
