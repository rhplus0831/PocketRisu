import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const DATABASE_KEY = 'database/database.bin'
const DATABASE_ERROR = {
  error: 'The authoritative live database is unavailable for backup',
  code: 'BACKUP_DATABASE_UNAVAILABLE',
}
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function replaceLiveDatabase(cwd: string, value: Buffer | null): void {
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?').run(DATABASE_KEY)
      sqlite.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(DATABASE_KEY)
      sqlite.prepare('DELETE FROM chunk_manifest_publications WHERE manifest_key = ?')
        .run(DATABASE_KEY)
      sqlite.prepare('DELETE FROM kv WHERE key = ?').run(DATABASE_KEY)
      if (value !== null) {
        sqlite.prepare(
          'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        ).run(DATABASE_KEY, value, Date.now())
      }
    })()
  } finally {
    sqlite.close()
  }
}

function addStaleDatabaseSnapshot(cwd: string, value: Buffer): void {
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    sqlite.prepare(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('database/dbbackup-stale-but-valid.bin', value, Date.now())
  } finally {
    sqlite.close()
  }
}

async function expectNoFullExportArtifacts(server: ServerHandle): Promise<void> {
  const deadline = Date.now() + 10_000
  let artifacts: string[] = []
  while (Date.now() < deadline) {
    const pinEntries = await readdir(
      path.join(server.cwd, 'save', '.partial-export-spool'),
    ).catch(() => [])
    const databaseSpools = await readdir(
      path.join(server.cwd, 'save', '.spool'),
    ).catch(() => [])
    const backups = await readdir(path.join(server.cwd, 'backups')).catch(() => [])
    artifacts = [
      ...pinEntries.filter(name => name.startsWith('.full-export-')),
      ...databaseSpools.filter(name => name.startsWith('.database-risudat-')),
      ...backups.filter(name => name.startsWith('.risu-backup-save-')),
    ]
    if (artifacts.length === 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(artifacts).toEqual([])
}

async function expectBothRoutesFailClosed(
  server: ServerHandle,
  client: RisuClient,
): Promise<void> {
  const before = await readdir(path.join(server.cwd, 'backups')).catch(() => [])

  const download = await client.fetch('/api/backup/export')
  expect(download.status).toBe(500)
  expect(download.headers.get('content-disposition')).toBeNull()
  expect(download.headers.get('x-risu-backup-assets')).toBeNull()
  expect(download.headers.get('content-type')).toContain('application/json')
  await expect(download.json()).resolves.toEqual(DATABASE_ERROR)
  await expectNoFullExportArtifacts(server)

  const save = await client.fetch('/api/backup/server/save', { method: 'POST' })
  expect(save.status).toBe(500)
  expect(save.headers.get('content-type')).toContain('application/json')
  expect(save.headers.get('content-type')).not.toContain('application/x-ndjson')
  await expect(save.json()).resolves.toEqual(DATABASE_ERROR)
  await expectNoFullExportArtifacts(server)

  expect(await readdir(path.join(server.cwd, 'backups')).catch(() => [])).toEqual(before)
}

async function readServerSavedArchive(server: ServerHandle, response: Response): Promise<Buffer> {
  expect(response.status).toBe(200)
  const events = (await response.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const done = events.find(event => event.type === 'done')
  expect(done).toBeTruthy()
  return readFile(path.join(server.cwd, 'backups', String(done!.filename)))
}

function databaseEntry(archive: Buffer): Buffer {
  const entry = decodeBackup(archive).find(candidate => candidate.name === 'database.risudat')
  expect(entry).toBeTruthy()
  return entry!.data
}

describe('full export authoritative database source', () => {
  test('both routes reject missing, zero-byte, and corrupt live databases before pinning, then recover', async () => {
    const gateDir = await mkdtemp(path.join(tmpdir(), 'risu-missing-db-pin-gate-'))
    const holdPath = path.join(gateDir, 'hold')
    const enteredPath = path.join(gateDir, 'entered')
    await writeFile(holdPath, 'hold', 'utf-8')
    try {
      const server = await spawnServer({
        env: { POCKETRISU_TEST_FULL_EXPORT_DURING_PIN_GATE_DIR: gateDir },
      })
      servers.push(server)
      const client = await createClient(server.port, server.password)
      const seededArchive = createSeedBackup()
      expect((await client.importBackup(seededArchive)).ok).toBe(true)
      const seededDatabase = databaseEntry(seededArchive)

      // A valid recovery snapshot must never stand in for the missing live DB.
      addStaleDatabaseSnapshot(server.cwd, seededDatabase)
      for (const invalid of [
        null,
        Buffer.alloc(0),
        Buffer.concat([
          Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]),
          Buffer.from([0x81]), // truncated MessagePack map
        ]),
      ]) {
        replaceLiveDatabase(server.cwd, invalid)
        await expectBothRoutesFailClosed(server, client)
        await expect(access(enteredPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }

      // An empty logical database is valid when its authoritative encoded row exists.
      const emptyDatabase = databaseEntry(createSeedBackup({ characterCount: 0 }))
      replaceLiveDatabase(server.cwd, emptyDatabase)
      await unlink(holdPath)

      const download = await client.fetch('/api/backup/export')
      expect(download.status).toBe(200)
      const downloadedArchive = Buffer.from(await download.arrayBuffer())
      expect(decodeRisuDat(databaseEntry(downloadedArchive)).characters).toEqual([])

      const savedArchive = await readServerSavedArchive(
        server,
        await client.fetch('/api/backup/server/save', { method: 'POST' }),
      )
      expect(decodeRisuDat(databaseEntry(savedArchive)).characters).toEqual([])
      await expectNoFullExportArtifacts(server)

      const destination = await spawnServer()
      servers.push(destination)
      const destinationClient = await createClient(destination.port, destination.password)
      expect(await destinationClient.importBackup(downloadedArchive)).toMatchObject({ ok: true })
    } finally {
      await rm(gateDir, { recursive: true, force: true })
    }
  }, 60_000)
})
