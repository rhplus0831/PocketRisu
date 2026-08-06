import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { zipSync } from 'fflate'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function entriesByName(archive: Buffer): Map<string, Buffer> {
  return new Map(decodeBackup(archive).map(entry => [entry.name, entry.data]))
}

function seedDatabase(): Buffer {
  return decodeBackup(createSeedBackup({ characterCount: 0 }))
    .find(entry => entry.name === 'database.risudat')!.data
}

function saveFolderZip(entries: Record<string, Buffer>): Buffer {
  const values: Record<string, Uint8Array> = {}
  for (const [key, value] of Object.entries(entries)) {
    values[Buffer.from(key, 'utf8').toString('hex')] = new Uint8Array(value)
  }
  return Buffer.from(zipSync(values))
}

async function importSaveFolder(
  client: RisuClient,
  entries: Record<string, Buffer>,
): Promise<void> {
  const response = await client.fetch('/api/migrate/save-folder/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: new Uint8Array(saveFolderZip(entries)),
  })
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toMatchObject({ ok: true })
}

async function readStorage(client: RisuClient, key: string): Promise<Buffer | null> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': Buffer.from(key, 'utf8').toString('hex') },
  })
  if (response.status === 204) return null
  expect(response.status).toBe(200)
  return Buffer.from(await response.arrayBuffer())
}

async function serverSavedArchive(server: ServerHandle, client: RisuClient): Promise<Buffer> {
  const response = await client.fetch('/api/backup/server/save', { method: 'POST' })
  expect(response.status).toBe(200)
  const events = (await response.text()).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; filename?: string })
  const done = events.find(event => event.type === 'done')
  expect(done?.filename).toBeTruthy()
  return readFile(path.join(server.cwd, 'backups', done!.filename!))
}

async function partialArchive(client: RisuClient): Promise<Buffer> {
  const jobId = randomUUID()
  const created = await client.fetch('/api/backup/export/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'partial', jobId }),
  })
  expect(created.status).toBe(202)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const statusResponse = await client.fetch(`/api/backup/export/jobs/${jobId}`)
    expect(statusResponse.status).toBe(200)
    const status = await statusResponse.json() as { state: string; error?: string }
    if (status.state === 'ready') {
      const download = await client.fetch(`/api/backup/export/jobs/${jobId}/download`)
      expect(download.status).toBe(200)
      return Buffer.from(await download.arrayBuffer())
    }
    if (status.state === 'failed' || status.state === 'cancelled') {
      throw new Error(status.error ?? `Partial export ${status.state}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for partial export')
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await access(filePath)
      return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

function writeKvValue(cwd: string, key: string, value: Buffer): void {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    db.prepare(`
      INSERT INTO kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  } finally {
    db.close()
  }
}

function readKvValue(cwd: string, key: string): Buffer | null {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: Buffer }
      | undefined
    return row ? Buffer.from(row.value) : null
  } finally {
    db.close()
  }
}

describe('legacy KV inlay backup fallback', () => {
  test('full and server-file backups union KV fallbacks with authoritative filesystem inlays', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    const physicalBytes = Buffer.from('authoritative-filesystem-inlay')
    const physicalInfo = Buffer.from(JSON.stringify({
      ext: 'png',
      name: 'authoritative.png',
      type: 'image',
      width: 11,
      height: 12,
    }))
    expect(await sourceClient.importBackup(Buffer.concat([
      createSeedBackup({ characterCount: 0 }),
      encodeBackup([
        { name: 'inlay/physical.png', data: physicalBytes },
        { name: 'inlay_sidecar/physical', data: physicalInfo },
      ]),
    ]))).toMatchObject({ ok: true })

    const fallbackBytes = Buffer.from('legacy-kv-fallback')
    const fallbackPayload = Buffer.from(JSON.stringify({
      ext: 'webp',
      name: 'payload-name.webp',
      type: 'image',
      data: `data:image/webp;base64,${fallbackBytes.toString('base64')}`,
    }))
    const fallbackInfo = Buffer.from(JSON.stringify({
      ext: 'webp',
      name: 'legacy-info-name.webp',
      type: 'image',
      width: 41,
      height: 42,
    }))
    const stalePayload = Buffer.from(JSON.stringify({
      ext: 'jpg',
      name: 'stale.jpg',
      type: 'image',
      data: `data:image/jpeg;base64,${Buffer.from('stale-kv').toString('base64')}`,
    }))
    const staleInfo = Buffer.from(JSON.stringify({
      ext: 'jpg', name: 'stale.jpg', type: 'image', width: 99, height: 99,
    }))
    await importSaveFolder(sourceClient, {
      'database/database.bin': seedDatabase(),
      'inlay/fallback': fallbackPayload,
      'inlay_info/fallback': fallbackInfo,
      'inlay/physical': stalePayload,
      'inlay_info/physical': staleInfo,
    })

    const downloaded = await sourceClient.exportBackup()
    const serverSaved = await serverSavedArchive(source, sourceClient)
    const mainResponse = await sourceClient.fetch('/api/backup/export?target=main')
    expect(mainResponse.status).toBe(200)
    const main = Buffer.from(await mainResponse.arrayBuffer())
    for (const archive of [downloaded, serverSaved, main]) {
      const entries = entriesByName(archive)
      expect(entries.get('inlay/fallback')).toEqual(fallbackPayload)
      expect(entries.get('inlay_info/fallback')).toEqual(fallbackInfo)
      expect(entries.get('inlay/physical.png')).toEqual(physicalBytes)
      expect(JSON.parse(entries.get('inlay_sidecar/physical')!.toString('utf8')))
        .toEqual(JSON.parse(physicalInfo.toString('utf8')))
      expect(entries.has('inlay/physical')).toBe(false)
      expect(entries.has('inlay_info/physical')).toBe(false)
    }

    const upstreamResponse = await sourceClient.fetch('/api/backup/export?target=upstream')
    expect(upstreamResponse.status).toBe(200)
    const upstreamNames = decodeBackup(Buffer.from(await upstreamResponse.arrayBuffer()))
      .map(entry => entry.name)
    expect(upstreamNames.some(name => name.startsWith('inlay'))).toBe(false)
    const partialNames = decodeBackup(await partialArchive(sourceClient)).map(entry => entry.name)
    expect(partialNames.some(name => name.startsWith('inlay'))).toBe(false)

    const restored = await spawnServer()
    servers.push(restored)
    const restoredClient = await createClient(restored.port, restored.password)
    expect(await restoredClient.importBackup(downloaded)).toMatchObject({ ok: true })
    const restoredPayload = JSON.parse(
      (await readStorage(restoredClient, 'inlay/fallback'))!.toString('utf8'),
    ) as { data: string; name: string; width: number; height: number }
    expect(restoredPayload).toMatchObject({
      data: `data:image/webp;base64,${fallbackBytes.toString('base64')}`,
      name: 'legacy-info-name.webp',
      width: 41,
      height: 42,
    })
    expect(JSON.parse(
      (await readStorage(restoredClient, 'inlay_info/fallback'))!.toString('utf8'),
    )).toMatchObject({
      ext: 'webp', name: 'legacy-info-name.webp', width: 41, height: 42,
    })
    const reexported = entriesByName(await restoredClient.exportBackup())
    expect(reexported.get('inlay/fallback.webp')).toEqual(fallbackBytes)
    expect(reexported.has('inlay/fallback')).toBe(false)
    expect(reexported.has('inlay_info/fallback')).toBe(false)
  }, 120_000)

  test('startup retries rows despite an old marker and publishes it only after all rows migrate', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect(await client.importBackup(createSeedBackup({ characterCount: 0 })))
      .toMatchObject({ ok: true })
    const marker = path.join(server.cwd, 'save', 'inlays', '.migrated_to_fs')
    await access(marker)

    await server.crash()
    writeKvValue(server.cwd, 'inlay/retry', Buffer.from('{invalid legacy payload'))
    await writeFile(marker, 'old marker', 'utf8')
    await server.restart()
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readKvValue(server.cwd, 'inlay/retry')).toEqual(Buffer.from('{invalid legacy payload'))

    await server.crash()
    const bytes = Buffer.from('retry-success')
    writeKvValue(server.cwd, 'inlay/retry', Buffer.from(JSON.stringify({
      ext: 'png',
      name: 'retry.png',
      type: 'image',
      data: `data:image/png;base64,${bytes.toString('base64')}`,
    })))
    writeKvValue(server.cwd, 'inlay_info/retry', Buffer.from(JSON.stringify({
      ext: 'png', name: 'retry-info.png', type: 'image', width: 7, height: 8,
    })))
    await writeFile(marker, 'stale marker', 'utf8')
    await server.restart()
    await access(marker)
    expect(readKvValue(server.cwd, 'inlay/retry')).toBeNull()
    expect(readKvValue(server.cwd, 'inlay_info/retry')).toBeNull()
    expect(await readFile(path.join(server.cwd, 'save', 'inlays', 'retry.png'))).toEqual(bytes)
    expect(JSON.parse(
      await readFile(path.join(server.cwd, 'save', 'inlays', 'retry.meta.json'), 'utf8'),
    )).toMatchObject({ name: 'retry-info.png', width: 7, height: 8 })
  }, 60_000)

  test('a filesystem inlay appearing after the cut cannot shadow the pinned KV fallback', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_TEST_FULL_EXPORT_DURING_PIN_GATE_DIR: 'pin-gate' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const fallbackBytes = Buffer.from('snapshot-kv-value')
    const fallbackPayload = Buffer.from(JSON.stringify({
      ext: 'png',
      name: 'snapshot-kv.png',
      type: 'image',
      data: `data:image/png;base64,${fallbackBytes.toString('base64')}`,
    }))
    const fallbackInfo = Buffer.from(JSON.stringify({
      ext: 'png', name: 'snapshot-kv.png', type: 'image', width: 1, height: 2,
    }))
    await importSaveFolder(client, {
      'database/database.bin': seedDatabase(),
      'inlay/snapshot-race': fallbackPayload,
      'inlay_info/snapshot-race': fallbackInfo,
    })

    const gateDir = path.join(server.cwd, 'pin-gate')
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    const exporting = client.fetch('/api/backup/export')
    await waitForPath(path.join(gateDir, 'entered'))
    await writeFile(
      path.join(server.cwd, 'save', 'inlays', 'snapshot-race.png'),
      Buffer.from('post-cut-filesystem-value'),
    )
    await writeFile(
      path.join(server.cwd, 'save', 'inlays', 'snapshot-race.meta.json'),
      JSON.stringify({ ext: 'png', name: 'post-cut.png', type: 'image' }),
    )
    await writeFile(path.join(gateDir, 'release'), '')
    const response = await exporting
    expect(response.status).toBe(200)
    const entries = entriesByName(Buffer.from(await response.arrayBuffer()))
    expect(entries.get('inlay/snapshot-race')).toEqual(fallbackPayload)
    expect(entries.get('inlay_info/snapshot-race')).toEqual(fallbackInfo)
    expect(entries.has('inlay/snapshot-race.png')).toBe(false)
    expect(entries.has('inlay_sidecar/snapshot-race')).toBe(false)
  }, 60_000)

  test('lossless exports reject unsafe legacy IDs while lossy exports keep omitting inlays', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const unsafePayload = Buffer.from(JSON.stringify({
      ext: 'png',
      type: 'image',
      data: `data:image/png;base64,${Buffer.from('unsafe').toString('base64')}`,
    }))
    await importSaveFolder(client, {
      'database/database.bin': seedDatabase(),
      'inlay/unsafe/id': unsafePayload,
    })
    expect(await readStorage(client, 'inlay/unsafe/id')).toEqual(unsafePayload)

    for (const [route, init] of [
      ['/api/backup/export', undefined],
      ['/api/backup/server/save', { method: 'POST' }],
      ['/api/backup/export?target=main', undefined],
    ] as const) {
      const response = await client.fetch(route, init)
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        code: 'BACKUP_UNSAFE_LEGACY_INLAY',
        error: expect.stringContaining('cannot safely archive legacy inlay key'),
      })
    }

    const upstream = await client.fetch('/api/backup/export?target=upstream')
    expect(upstream.status).toBe(200)
    expect(decodeBackup(Buffer.from(await upstream.arrayBuffer()))
      .some(entry => entry.name.startsWith('inlay'))).toBe(false)
    expect(decodeBackup(await partialArchive(client))
      .some(entry => entry.name.startsWith('inlay'))).toBe(false)
  }, 60_000)
})
