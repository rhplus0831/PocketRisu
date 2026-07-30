import { afterAll, describe, expect, test } from 'vitest'
import http from 'node:http'
import path from 'node:path'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

const DB_KEY = 'database/database.bin'
const DB_HEX = Buffer.from(DB_KEY).toString('hex')
const DEFAULT_IMPORT_LIMIT = 2 * 1024 * 1024 * 1024
const BUFFERED_ROW_LIMIT = 32 * 1024 * 1024
const LEGACY_DATABASE_LIMIT = 64 * 1024 * 1024

async function boot(env: Record<string, string> = {}): Promise<{
  server: ServerHandle
  client: RisuClient
}> {
  const server = await spawnServer({ env })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

function databaseEntry(backup: Buffer): Buffer {
  const entry = decodeBackup(backup).find(candidate => candidate.name === 'database.risudat')
  if (!entry) throw new Error('backup has no database.risudat')
  return entry.data
}

function saveFolderZip(database: Buffer): Buffer {
  return Buffer.from(zipSync({ [DB_HEX]: new Uint8Array(database) }, { level: 0 }))
}

function saveFolderZipWithRows(database: Buffer, rows: Array<{ key: string; value: Buffer }>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries([
    [DB_HEX, new Uint8Array(database)],
    ...rows.map(row => [Buffer.from(row.key).toString('hex'), new Uint8Array(row.value)]),
  ]), { level: 0 }))
}

async function writeSaveFolderSource(
  sourceDir: string,
  database: Buffer,
  rows: Array<{ key: string; value: Buffer }>,
): Promise<void> {
  await mkdir(sourceDir, { recursive: true })
  await writeFile(path.join(sourceDir, DB_HEX), database)
  for (const row of rows) {
    await writeFile(
      path.join(sourceDir, Buffer.from(row.key).toString('hex')),
      row.value,
    )
  }
}

function validJsonBytes(size: number): Buffer {
  if (size < 2) throw new Error('JSON fixture size must be at least two bytes')
  const value = Buffer.alloc(size, 0x20)
  value.write('{}', 0, 'utf8')
  return value
}

function blockDatabaseAtSize(size: number, note: string): Buffer {
  const magic = Buffer.from('RISUSAVE\0', 'binary')
  const blockPrefix = (type: number, name: string, bodyLength: number): Buffer => {
    const nameBytes = Buffer.from(name, 'utf-8')
    const prefix = Buffer.alloc(3 + nameBytes.length + 4)
    prefix[0] = type
    prefix[1] = 0
    prefix[2] = nameBytes.length
    nameBytes.copy(prefix, 3)
    prefix.writeUInt32LE(bodyLength, 3 + nameBytes.length)
    return prefix
  }
  const rootBody = Buffer.from(JSON.stringify({
    globalNote: note,
    optimizePluginMemory: false,
    personas: [],
  }), 'utf-8')
  const rootPrefix = blockPrefix(1, 'root', rootBody.length)
  const configPrefixBytes = 3 + Buffer.byteLength('config') + 4
  const configBodyLength = size
    - magic.length
    - rootPrefix.length
    - rootBody.length
    - configPrefixBytes
  if (configBodyLength < 2) throw new Error('Block database fixture size is too small')
  const configPrefix = blockPrefix(0, 'config', configBodyLength)
  const output = Buffer.alloc(size, 0x20)
  let offset = 0
  for (const part of [magic, rootPrefix, rootBody, configPrefix]) {
    part.copy(output, offset)
    offset += part.length
  }
  output.write('{}', offset, 'utf-8')
  return output
}

async function executeSaveFolder(client: RisuClient, sourceDir: string): Promise<Response> {
  return client.fetch('/api/migrate/save-folder/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: sourceDir }),
  })
}

async function uploadSaveFolder(client: RisuClient, zip: Buffer): Promise<Response> {
  return client.fetch('/api/migrate/save-folder/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: new Uint8Array(zip),
  })
}

async function readDatabase(client: RisuClient): Promise<Record<string, any>> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': DB_HEX },
  })
  expect(response.status).toBe(200)
  return decodeRisuDat(Buffer.from(await response.arrayBuffer())) as Record<string, any>
}

async function expectNote(client: RisuClient, note: string): Promise<void> {
  expect((await readDatabase(client)).globalNote).toBe(note)
}

async function expectStructuredNotCommitted(response: Response, status = 413): Promise<void> {
  const body = await response.json() as Record<string, unknown>
  expect(response.status).toBe(status)
  expect(body).toMatchObject({
    retryable: false,
    commitOutcome: 'not-committed',
    commitOutcomeUnknown: false,
  })
}

function paddedBackupAt(size: number, note: string): Buffer {
  const seed = createSeedBackup({ databaseFields: { globalNote: note } })
  const entries = decodeBackup(seed)
  const emptyPadding = encodeBackup([...entries, { name: 'padding', data: Buffer.alloc(0) }])
  if (emptyPadding.length > size) throw new Error('test cap is too small')
  return encodeBackup([
    ...entries,
    { name: 'padding', data: Buffer.alloc(size - emptyPadding.length) },
  ])
}

function spoolArtifacts(files: string[]): string[] {
  return files.filter(name => name.startsWith('.backup-import-')
    || name.startsWith('.database-risudat-backup-import-')
    || name.startsWith('.backup-entry-stage-')
    || name.startsWith('.save-folder-import-'))
}

async function waitForNoImportSpools(server: ServerHandle): Promise<void> {
  const spoolDir = path.join(server.cwd, 'save', '.spool')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const files = await readdir(spoolDir).catch(() => [] as string[])
    if (spoolArtifacts(files).length === 0) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(spoolArtifacts(await readdir(spoolDir))).toEqual([])
}

describe('bounded archive and save-folder ingress (real server)', () => {
  test('streams a 64 MiB + 1 RISUSAVE block database through archive and save-folder imports', async () => {
    const blockDatabase = blockDatabaseAtSize(
      LEGACY_DATABASE_LIMIT + 1,
      'large-block-database',
    )
    expect(blockDatabase.length).toBe(LEGACY_DATABASE_LIMIT + 1)
    const { server, client } = await boot({
      RISU_LEGACY_DATABASE_IMPORT_MAX_BYTES: '128',
      POCKETRISU_CHUNK_THRESHOLD: '4096',
    })

    const archive = encodeBackup([{ name: 'database.risudat', data: blockDatabase }])
    expect((await client.importBackup(archive)).ok).toBe(true)
    await expectNote(client, 'large-block-database')

    const sourceDir = path.join(server.cwd, 'large-block-save-folder')
    await writeSaveFolderSource(sourceDir, blockDatabase, [])
    const directoryResponse = await executeSaveFolder(client, sourceDir)
    expect(directoryResponse.status).toBe(200)
    await directoryResponse.json()
    await expectNote(client, 'large-block-database')
    await waitForNoImportSpools(server)
  }, 180_000)

  test('imports a 52 MiB supported database through archive and ZIP paths', async () => {
    const pluginCustomStorage = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [
      `large-row-${String(index).padStart(2, '0')}`,
      { index, payload: String(index % 10).repeat(4 * 1024 * 1024) },
    ]))
    const archive = createSeedBackup({
      databaseFields: {
        globalNote: 'large-archive',
        optimizePluginMemory: true,
        pluginCustomStorage,
      },
    })
    expect(archive.length).toBeGreaterThan(50 * 1024 * 1024)
    expect(archive.length).toBeLessThan(100 * 1024 * 1024)

    const { server, client } = await boot({ POCKETRISU_CHUNK_THRESHOLD: '4096' })
    expect((await client.importBackup(archive)).ok).toBe(true)
    await expectNote(client, 'large-archive')

    const zip = saveFolderZip(databaseEntry(archive))
    const uploaded = await uploadSaveFolder(client, zip)
    expect(uploaded.status).toBe(200)
    await expectNote(client, 'large-archive')

    const db = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    try {
      const count = db.prepare("SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'pluginsave/%'")
        .get() as { count: number }
      expect(count.count).toBe(13)
    } finally {
      db.close()
    }
    await waitForNoImportSpools(server)
  }, 180_000)

  test('streams a 52 MiB non-database entry through archive and save-folder asset stages', async () => {
    const database = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'large-streamed-asset' },
    }))
    const assetBytes = 52 * 1024 * 1024
    const asset = Buffer.alloc(assetBytes, 0x5a)
    const archive = encodeBackup([
      { name: 'database.risudat', data: database },
      { name: 'large-streamed-asset.bin', data: asset },
    ])
    expect(archive.length).toBeGreaterThan(50 * 1024 * 1024)
    expect(archive.length).toBeLessThan(100 * 1024 * 1024)

    const { server, client } = await boot()
    expect((await client.importBackup(archive)).ok).toBe(true)
    await expectNote(client, 'large-streamed-asset')
    expect((await stat(path.join(
      server.cwd,
      'save',
      'assets',
      'large-streamed-asset.bin',
    ))).size).toBe(assetBytes)

    const saveFolder = Buffer.from(zipSync({
      [DB_HEX]: new Uint8Array(database),
      [Buffer.from('assets/large-streamed-asset.bin').toString('hex')]: new Uint8Array(asset),
    }, { level: 0 }))
    const uploaded = await uploadSaveFolder(client, saveFolder)
    expect(uploaded.status).toBe(200)
    await uploaded.json()
    await expectNote(client, 'large-streamed-asset')
    expect((await stat(path.join(
      server.cwd,
      'save',
      'assets',
      'large-streamed-asset.bin',
    ))).size).toBe(assetBytes)
    await waitForNoImportSpools(server)
  }, 120_000)

  test('retains >32 MiB file-backed plugin values through ZIP and directory imports', async () => {
    const pluginKey = `pluginsave/${Buffer.from('large-file-backed-value').toString('base64url')}.json`
    const pluginValue = validJsonBytes(40 * 1024 * 1024)
    const database = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'large-file-backed-plugin' },
    }))
    const { server, client } = await boot({ POCKETRISU_CHUNK_THRESHOLD: '4096' })

    const zipResponse = await uploadSaveFolder(
      client,
      saveFolderZipWithRows(database, [{ key: pluginKey, value: pluginValue }]),
    )
    expect(zipResponse.status).toBe(200)
    await zipResponse.json()
    await expectNote(client, 'large-file-backed-plugin')

    const sourceDir = path.join(server.cwd, 'large-plugin-directory')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, DB_HEX), database)
    await writeFile(path.join(sourceDir, Buffer.from(pluginKey).toString('hex')), pluginValue)
    const directoryResponse = await executeSaveFolder(client, sourceDir)
    expect(directoryResponse.status).toBe(200)
    await directoryResponse.json()
    await expectNote(client, 'large-file-backed-plugin')
    await waitForNoImportSpools(server)
  }, 120_000)

  const boundedRows = [
    { label: 'generic', key: 'generic/large-row.bin', json: false },
    {
      label: 'plugin metadata',
      key: `pluginsave-meta/${Buffer.from('large-meta').toString('base64url')}.json`,
      json: true,
    },
  ] as const

  for (const route of ['ZIP', 'directory'] as const) {
    for (const row of boundedRows) {
      test(`${route} ${row.label} row accepts exactly 32 MiB and rejects +1`, async () => {
        const exactValue = row.json
          ? validJsonBytes(BUFFERED_ROW_LIMIT)
          : Buffer.alloc(BUFFERED_ROW_LIMIT, 0x41)
        const exactDatabase = databaseEntry(createSeedBackup({
          databaseFields: { globalNote: `${route}-${row.label}-exact` },
        }))
        const rejectedDatabase = databaseEntry(createSeedBackup({
          databaseFields: { globalNote: 'must-not-publish' },
        }))
        const { server, client } = await boot()
        let rejected: Response

        if (route === 'ZIP') {
          const accepted = await uploadSaveFolder(
            client,
            saveFolderZipWithRows(exactDatabase, [{ key: row.key, value: exactValue }]),
          )
          expect(accepted.status).toBe(200)
          await accepted.json()
          rejected = await uploadSaveFolder(
            client,
            saveFolderZipWithRows(rejectedDatabase, [{
              key: row.key,
              value: Buffer.concat([exactValue, Buffer.from([0x20])]),
            }]),
          )
        } else {
          const sourceDir = path.join(server.cwd, `bounded-${row.label.replaceAll(' ', '-')}`)
          const rowPath = path.join(sourceDir, Buffer.from(row.key).toString('hex'))
          await mkdir(sourceDir, { recursive: true })
          await writeFile(path.join(sourceDir, DB_HEX), exactDatabase)
          await writeFile(rowPath, exactValue)
          const accepted = await executeSaveFolder(client, sourceDir)
          expect(accepted.status).toBe(200)
          await accepted.json()
          await writeFile(path.join(sourceDir, DB_HEX), rejectedDatabase)
          await writeFile(rowPath, Buffer.concat([exactValue, Buffer.from([0x20])]))
          rejected = await executeSaveFolder(client, sourceDir)
        }

        await expectStructuredNotCommitted(rejected)
        await expectNote(client, `${route}-${row.label}-exact`)
        await waitForNoImportSpools(server)
      }, 120_000)
    }
  }

  for (const route of ['ZIP', 'directory'] as const) {
    for (const row of [
      { label: 'remote', key: 'remotes/large.local.bin' },
      { label: 'unsafe asset', key: 'assets/.unsafe-large-row' },
    ] as const) {
      test(`${route} ${row.label} row streams above the former 32 MiB limit`, async () => {
        const value = Buffer.alloc(BUFFERED_ROW_LIMIT + 1, 0x52)
        const database = databaseEntry(createSeedBackup({
          databaseFields: { globalNote: `${route}-${row.label}-streamed` },
        }))
        const { server, client } = await boot({ POCKETRISU_CHUNK_THRESHOLD: '4096' })

        let response: Response
        if (route === 'ZIP') {
          response = await uploadSaveFolder(
            client,
            saveFolderZipWithRows(database, [{ key: row.key, value }]),
          )
        } else {
          const sourceDir = path.join(server.cwd, `streamed-${row.label.replaceAll(' ', '-')}`)
          await writeSaveFolderSource(sourceDir, database, [{ key: row.key, value }])
          response = await executeSaveFolder(client, sourceDir)
        }

        expect(response.status).toBe(200)
        await response.json()
        await expectNote(client, `${route}-${row.label}-streamed`)
        await waitForNoImportSpools(server)
      }, 120_000)
    }
  }

  test('backup import streams large raw inlays and cold-storage JSON', async () => {
    const database = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'large-streamed-backup-categories' },
    }))
    const inlay = Buffer.alloc(BUFFERED_ROW_LIMIT + 1, 0x49)
    const cold = validJsonBytes(BUFFERED_ROW_LIMIT + 1)
    const unsafeAsset = Buffer.alloc(BUFFERED_ROW_LIMIT + 1, 0x55)
    const archive = encodeBackup([
      { name: 'database.risudat', data: database },
      { name: 'inlay/large-inlay.bin', data: inlay },
      { name: 'coldstorage/large-character.json', data: cold },
      { name: '.unsafe-large-asset', data: unsafeAsset },
    ])
    const { server, client } = await boot({ POCKETRISU_CHUNK_THRESHOLD: '4096' })

    expect((await client.importBackup(archive)).ok).toBe(true)
    await expectNote(client, 'large-streamed-backup-categories')
    expect((await stat(path.join(server.cwd, 'save', 'inlays', 'large-inlay.bin'))).size)
      .toBe(inlay.length)
    const coldResponse = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from('coldstorage/large-character').toString('hex') },
    })
    expect(coldResponse.status).toBe(200)
    expect(Buffer.from(await coldResponse.arrayBuffer()).subarray(0, 2)).toEqual(
      Buffer.from([0x1f, 0x8b]),
    )
    const unsafeResponse = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from('assets/.unsafe-large-asset').toString('hex') },
    })
    expect(unsafeResponse.status).toBe(200)
    expect((await unsafeResponse.arrayBuffer()).byteLength).toBe(unsafeAsset.length)

    const reexported = await client.exportBackup()
    expect(decodeBackup(reexported).find(entry => entry.name === '.unsafe-large-asset')?.data.length)
      .toBe(unsafeAsset.length)
    expect((await client.importBackup(reexported)).ok).toBe(true)
    await expectNote(client, 'large-streamed-backup-categories')
    await waitForNoImportSpools(server)
  }, 120_000)

  test('explicit large restore bypasses soft byte and entry-count caps atomically', async () => {
    const softByteCap = 1024 * 1024
    const archive = encodeBackup([
      ...decodeBackup(paddedBackupAt(softByteCap + 1, 'large-restore-confirmed')),
      { name: 'second-small-asset', data: Buffer.from('ok') },
    ])
    const { client } = await boot({
      RISU_BACKUP_IMPORT_MAX_BYTES: String(softByteCap),
      RISU_BACKUP_IMPORT_MAX_ENTRIES: '2',
    })

    const ordinaryPrepare = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: archive.length }),
    })
    await expectStructuredNotCommitted(ordinaryPrepare)

    const confirmedPrepare = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: archive.length, allowLargeRestore: true }),
    })
    expect(confirmedPrepare.status).toBe(200)

    const restored = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-risu-backup',
        'x-risu-large-restore': '1',
      },
      body: new Uint8Array(archive),
    })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ ok: true })
    await expectNote(client, 'large-restore-confirmed')

    const serverProduced = await client.exportBackup()
    expect(serverProduced.length).toBeGreaterThan(softByteCap)
    expect(decodeBackup(serverProduced).length).toBeGreaterThan(2)
    const roundTrip = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-risu-backup',
        'x-risu-large-restore': '1',
      },
      body: new Uint8Array(serverProduced),
    })
    expect(roundTrip.status).toBe(200)
    expect(await roundTrip.json()).toMatchObject({ ok: true })
    await expectNote(client, 'large-restore-confirmed')
  }, 120_000)

  test('archive cap accepts exact bytes, rejects +1, and default cap is finite', async () => {
    const cap = 1024 * 1024
    const exact = paddedBackupAt(cap, 'exact-archive')
    expect(exact.length).toBe(cap)
    const { client } = await boot({ RISU_BACKUP_IMPORT_MAX_BYTES: String(cap) })

    expect((await client.importBackup(exact)).ok).toBe(true)
    const over = Buffer.concat([exact, Buffer.from([0])])
    const response = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(over),
    })
    await expectStructuredNotCommitted(response)
    await expectNote(client, 'exact-archive')

    const { client: defaultClient } = await boot()
    const prepared = await defaultClient.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: DEFAULT_IMPORT_LIMIT + 1 }),
    })
    // No cap environment variable was supplied to this server: the production
    // default itself is finite and authoritative.
    await expectStructuredNotCommitted(prepared)
  })

  test('disk headroom accepts the exact boundary and rejects one byte less', async () => {
    const sourceBytes = 4096
    const requiredBytes = sourceBytes * 2
    const { client: exactClient } = await boot({
      POCKETRISU_TEST_IMPORT_AVAILABLE_BYTES: String(requiredBytes),
    })
    const accepted = await exactClient.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: sourceBytes }),
    })
    expect(accepted.status).toBe(200)

    const { client: shortClient } = await boot({
      POCKETRISU_TEST_IMPORT_AVAILABLE_BYTES: String(requiredBytes - 1),
    })
    const rejected = await shortClient.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: sourceBytes }),
    })
    await expectStructuredNotCommitted(rejected, 507)
  })

  test('save-folder ZIP cap accepts exact bytes and rejects +1 without publication', async () => {
    const database = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'exact-save-folder' },
    }))
    const zip = saveFolderZip(database)
    const { client } = await boot({ RISU_BACKUP_IMPORT_MAX_BYTES: String(zip.length) })

    const accepted = await uploadSaveFolder(client, zip)
    expect(accepted.status).toBe(200)
    await accepted.json()
    const response = await uploadSaveFolder(client, Buffer.concat([zip, Buffer.from([0])]))
    await expectStructuredNotCommitted(response)
    await expectNote(client, 'exact-save-folder')
  })

  test('directory import enforces the same finite entry cap while staging serially', async () => {
    const { server, client } = await boot({
      RISU_SAVE_FOLDER_IMPORT_MAX_ENTRIES: '2',
    })
    const sourceDir = path.join(server.cwd, 'bounded-directory-source')
    await mkdir(sourceDir, { recursive: true })
    const hexName = (key: string) => Buffer.from(key).toString('hex')
    await writeFile(
      path.join(sourceDir, hexName(DB_KEY)),
      databaseEntry(createSeedBackup({ databaseFields: { globalNote: 'directory-cap' } })),
    )
    await writeFile(
      path.join(sourceDir, hexName('remotes/one.local.bin')),
      Buffer.from('{"one":true}'),
    )
    const accepted = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sourceDir }),
    })
    expect(accepted.status).toBe(200)
    await accepted.json()

    await writeFile(
      path.join(sourceDir, hexName('remotes/two.local.bin')),
      Buffer.from('{"two":true}'),
    )
    const rejected = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sourceDir }),
    })
    await expectStructuredNotCommitted(rejected)
    await expectNote(client, 'directory-cap')
    await waitForNoImportSpools(server)
  })

  test('directory aggregate byte cap accepts exact total and rejects total +1', async () => {
    const exactDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'directory-aggregate-exact' },
    }))
    const rowValue = Buffer.alloc(1024 * 1024, 0x33)
    const aggregateCap = exactDatabase.length + rowValue.length
    const { server, client } = await boot({
      RISU_BACKUP_IMPORT_MAX_BYTES: String(aggregateCap),
    })
    const sourceDir = path.join(server.cwd, 'aggregate-directory-source')
    const rowPath = path.join(
      sourceDir,
      Buffer.from('generic/aggregate.bin').toString('hex'),
    )
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, DB_HEX), exactDatabase)
    await writeFile(rowPath, rowValue)
    const accepted = await executeSaveFolder(client, sourceDir)
    expect(accepted.status).toBe(200)
    await accepted.json()

    await writeFile(rowPath, Buffer.concat([rowValue, Buffer.from([0])]))
    const rejected = await executeSaveFolder(client, sourceDir)
    await expectStructuredNotCommitted(rejected)
    await expectNote(client, 'directory-aggregate-exact')
    await waitForNoImportSpools(server)
  })

  test('legacy database cap is definitive and preserves the old publication', async () => {
    const { client } = await boot({
      RISU_BACKUP_IMPORT_MAX_BYTES: String(1024 * 1024),
      RISU_LEGACY_DATABASE_IMPORT_MAX_BYTES: '128',
    })
    expect((await client.importBackup(createSeedBackup({
      databaseFields: { globalNote: 'before-legacy-limit' },
    }))).ok).toBe(true)
    const legacy = encodeBackup([{ name: 'database.risudat', data: Buffer.alloc(129, 0x61) }])
    const response = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(legacy),
    })
    await expectStructuredNotCommitted(response)
    await expectNote(client, 'before-legacy-limit')
  })

  test('partial socket abort never mutates and restart sweeps every private stage', async () => {
    const { server, client } = await boot()
    expect((await client.importBackup(createSeedBackup({
      databaseFields: { globalNote: 'before-abort' },
    }))).ok).toBe(true)
    const candidate = createSeedBackup({ databaseFields: { globalNote: 'must-not-publish' } })

    await new Promise<void>((resolve) => {
      const request = http.request({
        host: '127.0.0.1',
        port: server.port,
        path: '/api/backup/import',
        method: 'POST',
        headers: {
          'risu-auth': client.token,
          'content-type': 'application/x-risu-backup',
          'content-length': String(candidate.length),
        },
      })
      request.on('error', () => resolve())
      request.write(candidate.subarray(0, Math.max(1, Math.floor(candidate.length / 2))), () => {
        setTimeout(() => request.destroy(), 25)
      })
      request.on('close', () => resolve())
    })
    await waitForNoImportSpools(server)
    await expectNote(client, 'before-abort')

    const spoolDir = path.join(server.cwd, 'save', '.spool')
    await mkdir(path.join(spoolDir, '.save-folder-import-orphan'), { recursive: true })
    await mkdir(path.join(spoolDir, '.backup-entry-stage-orphan'), { recursive: true })
    await writeFile(path.join(spoolDir, '.save-folder-import-orphan', 'row'), 'orphan')
    await writeFile(path.join(spoolDir, '.backup-entry-stage-orphan', 'row'), 'orphan')
    await writeFile(path.join(spoolDir, '.backup-import-orphan.tmp'), 'orphan')
    await server.restart()
    const restarted = await createClient(server.port, server.password)
    await waitForNoImportSpools(server)
    await expectNote(restarted, 'before-abort')
  })

  test('post-ingestion failure rolls back and remains durable after restart', async () => {
    const { server, client } = await boot()
    expect((await client.importBackup(createSeedBackup({
      databaseFields: { globalNote: 'before-rollback' },
    }))).ok).toBe(true)

    await server.restart({
      POCKETRISU_TEST_BACKUP_IMPORT_FAILPOINT: 'after-database-ingestion',
    })
    const failingClient = await createClient(server.port, server.password)
    const response = await failingClient.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(createSeedBackup({
        databaseFields: { globalNote: 'must-roll-back' },
      })),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      code: 'BACKUP_IMPORT_NOT_COMMITTED',
      retryable: true,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    await waitForNoImportSpools(server)

    await server.restart({ POCKETRISU_TEST_BACKUP_IMPORT_FAILPOINT: '' })
    const restarted = await createClient(server.port, server.password)
    await expectNote(restarted, 'before-rollback')
    await waitForNoImportSpools(server)
  })

  test('save-folder failure after asset swap rolls back database and files durably', async () => {
    const { server, client } = await boot()
    const assetKey = 'assets/save-folder-rollback.bin'
    const newAssetKey = 'assets/save-folder-must-disappear.bin'
    const oldAsset = Buffer.from('durable old asset')
    const candidateAsset = Buffer.from('candidate replacement asset')
    const oldDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'before-save-folder-rollback' },
    }))
    const candidateDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'must-not-publish-save-folder' },
    }))
    const baseline = await uploadSaveFolder(
      client,
      saveFolderZipWithRows(oldDatabase, [{ key: assetKey, value: oldAsset }]),
    )
    expect(baseline.status).toBe(200)
    await baseline.json()

    await server.restart({
      POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: 'after-asset-swap',
    })
    const failingClient = await createClient(server.port, server.password)
    const response = await uploadSaveFolder(
      failingClient,
      saveFolderZipWithRows(candidateDatabase, [
        { key: assetKey, value: candidateAsset },
        { key: newAssetKey, value: candidateAsset },
      ]),
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      code: 'SAVE_FOLDER_IMPORT_NOT_COMMITTED',
      retryable: true,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    await expectNote(failingClient, 'before-save-folder-rollback')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(oldAsset)
    await expect(stat(path.join(server.cwd, 'save', newAssetKey))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(path.join(server.cwd, 'save'))).not.toContain('import_journal.json')
    await waitForNoImportSpools(server)

    await server.restart({ POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: '' })
    const restarted = await createClient(server.port, server.password)
    await expectNote(restarted, 'before-save-folder-rollback')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(oldAsset)
    await expect(stat(path.join(server.cwd, 'save', newAssetKey))).rejects.toMatchObject({ code: 'ENOENT' })

    const admitted = await uploadSaveFolder(
      restarted,
      saveFolderZipWithRows(candidateDatabase, [
        { key: assetKey, value: candidateAsset },
        { key: newAssetKey, value: candidateAsset },
      ]),
    )
    expect(admitted.status).toBe(200)
    await admitted.json()
    await expectNote(restarted, 'must-not-publish-save-folder')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(candidateAsset)
    expect(await readFile(path.join(server.cwd, 'save', newAssetKey))).toEqual(candidateAsset)
    await waitForNoImportSpools(server)
  }, 60_000)

  test('validation failure reports unknown when rollback cleanup cannot be proven', async () => {
    const { server, client } = await boot()
    const oldDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'before-validation-rollback-ambiguity' },
    }))
    const invalidDatabase = databaseEntry(createSeedBackup({
      databaseFields: {
        globalNote: 'invalid-validation-candidate',
        optimizePluginMemory: true,
        pluginStorageFolded: true,
        pluginCustomStorage: [],
      },
    }))
    const baseline = await uploadSaveFolder(client, saveFolderZip(oldDatabase))
    expect(baseline.status).toBe(200)
    await baseline.json()

    await server.restart({
      POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: 'rollback-cleanup',
    })
    const failingClient = await createClient(server.port, server.password)
    const response = await uploadSaveFolder(failingClient, saveFolderZip(invalidDatabase))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Save-folder import outcome is unknown because rollback recovery failed',
      code: 'SAVE_FOLDER_IMPORT_OUTCOME_UNKNOWN',
      retryable: false,
      commitOutcome: 'unknown',
      commitOutcomeUnknown: true,
    })
    await expectNote(failingClient, 'before-validation-rollback-ambiguity')

    await server.restart({ POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: '' })
    const restarted = await createClient(server.port, server.password)
    await expectNote(restarted, 'before-validation-rollback-ambiguity')
    await waitForNoImportSpools(server)
  }, 60_000)

  test('asset-swap rollback failure reports unknown and restart reconciles old state', async () => {
    const { server, client } = await boot()
    const assetKey = 'assets/save-folder-unknown-rollback.bin'
    const oldAsset = Buffer.from('old rollback-ambiguity asset')
    const candidateAsset = Buffer.from('candidate rollback-ambiguity asset')
    const oldDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'before-generic-rollback-ambiguity' },
    }))
    const candidateDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'candidate-generic-rollback-ambiguity' },
    }))
    const baseline = await uploadSaveFolder(
      client,
      saveFolderZipWithRows(oldDatabase, [{ key: assetKey, value: oldAsset }]),
    )
    expect(baseline.status).toBe(200)
    await baseline.json()

    await server.restart({
      POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: 'after-asset-swap,rollback-cleanup',
    })
    const failingClient = await createClient(server.port, server.password)
    const response = await uploadSaveFolder(
      failingClient,
      saveFolderZipWithRows(candidateDatabase, [{ key: assetKey, value: candidateAsset }]),
    )
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Save-folder import outcome is unknown because rollback recovery failed',
      code: 'SAVE_FOLDER_IMPORT_OUTCOME_UNKNOWN',
      retryable: false,
      commitOutcome: 'unknown',
      commitOutcomeUnknown: true,
    })
    // SQLite rollback and failed filesystem rollback leave a deliberately
    // uncertain mixed view until journal recovery runs at restart.
    await expectNote(failingClient, 'before-generic-rollback-ambiguity')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(candidateAsset)

    await server.restart({ POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: '' })
    const restarted = await createClient(server.port, server.password)
    await expectNote(restarted, 'before-generic-rollback-ambiguity')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(oldAsset)
    expect(await readdir(path.join(server.cwd, 'save'))).not.toContain('import_journal.json')
    await waitForNoImportSpools(server)
  }, 60_000)

  test('ZIP import reports post-COMMIT cleanup failure as committed and stays durable', async () => {
    const { server, client } = await boot()
    const assetKey = 'assets/save-folder-post-commit.bin'
    const oldAsset = Buffer.from('old post-commit asset')
    const candidateAsset = Buffer.from('new post-commit asset')
    const oldDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'before-post-commit-cleanup' },
    }))
    const candidateDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'committed-post-commit-cleanup' },
    }))
    const baseline = await uploadSaveFolder(
      client,
      saveFolderZipWithRows(oldDatabase, [{ key: assetKey, value: oldAsset }]),
    )
    expect(baseline.status).toBe(200)
    await baseline.json()

    await server.restart({
      POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: 'post-commit-cleanup',
    })
    const failingClient = await createClient(server.port, server.password)
    const response = await uploadSaveFolder(
      failingClient,
      saveFolderZipWithRows(candidateDatabase, [{ key: assetKey, value: candidateAsset }]),
    )
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Injected save-folder cleanup failure after commit',
      code: 'SAVE_FOLDER_IMPORT_POST_COMMIT_CLEANUP_FAILED',
      retryable: false,
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })
    await expectNote(failingClient, 'committed-post-commit-cleanup')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(candidateAsset)

    await server.restart({ POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: '' })
    const restarted = await createClient(server.port, server.password)
    await expectNote(restarted, 'committed-post-commit-cleanup')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(candidateAsset)
    expect(await readdir(path.join(server.cwd, 'save'))).not.toContain('import_journal.json')
    await waitForNoImportSpools(server)
  }, 60_000)

  test('direct import reports migration-marker failure as committed and stays durable', async () => {
    const { server, client } = await boot()
    const assetKey = 'assets/save-folder-marker.bin'
    const oldAsset = Buffer.from('old marker asset')
    const candidateAsset = Buffer.from('new marker asset')
    const oldDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'before-marker-failure' },
    }))
    const candidateDatabase = databaseEntry(createSeedBackup({
      databaseFields: { globalNote: 'committed-marker-failure' },
    }))
    const baseline = await uploadSaveFolder(
      client,
      saveFolderZipWithRows(oldDatabase, [{ key: assetKey, value: oldAsset }]),
    )
    expect(baseline.status).toBe(200)
    await baseline.json()

    const sourceDir = path.join(server.cwd, 'marker-failure-source')
    await writeSaveFolderSource(
      sourceDir,
      candidateDatabase,
      [{ key: assetKey, value: candidateAsset }],
    )
    const migrationMarker = path.join(server.cwd, 'save', '.migrated_to_sqlite')
    await rm(migrationMarker, { force: true })
    await server.restart({
      POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: 'migration-marker',
    })
    const failingClient = await createClient(server.port, server.password)
    const response = await executeSaveFolder(failingClient, sourceDir)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Injected save-folder migration-marker failure after commit',
      code: 'SAVE_FOLDER_IMPORT_MIGRATION_MARKER_FAILED',
      retryable: false,
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })
    await expectNote(failingClient, 'committed-marker-failure')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(candidateAsset)
    await expect(stat(migrationMarker)).rejects.toMatchObject({ code: 'ENOENT' })

    await server.restart({ POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT: '' })
    const restarted = await createClient(server.port, server.password)
    await expectNote(restarted, 'committed-marker-failure')
    expect(await readFile(path.join(server.cwd, 'save', assetKey))).toEqual(candidateAsset)
    expect(await readdir(path.join(server.cwd, 'save'))).not.toContain('import_journal.json')
    await waitForNoImportSpools(server)
  }, 60_000)
})
