import path from 'node:path'
import { request as httpRequest } from 'node:http'
import { deflateSync, gzipSync } from 'node:zlib'
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const MIB = 1024 * 1024
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function epochBackup(epoch: 'old' | 'new', asset: Buffer, inlay: Buffer): Buffer {
  return Buffer.concat([
    createSeedBackup({ databaseFields: { fullExportEpoch: epoch } }),
    encodeBackup([
      { name: 'epoch.bin', data: asset },
      { name: 'inlay/epoch.bin', data: inlay },
      {
        name: 'inlay_sidecar/epoch',
        data: Buffer.from(JSON.stringify({ ext: 'bin', name: `${epoch}-inlay`, type: 'image' })),
      },
      {
        name: 'inlay_meta/epoch',
        data: Buffer.from(JSON.stringify({ epoch })),
      },
    ]),
  ])
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(filePath)
      return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function waitForNoFullExportPins(cwd: string, timeoutMs = 10_000): Promise<void> {
  const spoolDir = path.join(cwd, 'save', '.partial-export-spool')
  const deadline = Date.now() + timeoutMs
  let lastEntries: string[] = []
  while (Date.now() < deadline) {
    const entries = await readdir(spoolDir).catch(() => [])
    lastEntries = entries
    if (!entries.some(entry => entry.startsWith('.full-export-'))) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Full backup export pins were not cleaned: ${lastEntries.join(', ')}`)
}

async function waitForFullExportPin(cwd: string, timeoutMs = 10_000): Promise<void> {
  const spoolDir = path.join(cwd, 'save', '.partial-export-spool')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = await readdir(spoolDir).catch(() => [])
    if (entries.some(entry => entry.startsWith('.full-export-'))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Full backup export pin was not created')
}

async function waitForNoDatabaseSpools(
  server: ServerHandle,
  timeoutMs = 10_000,
): Promise<void> {
  const spoolDir = server.spoolDir
  const deadline = Date.now() + timeoutMs
  let lastEntries: string[] = []
  while (Date.now() < deadline) {
    const entries = await readdir(spoolDir).catch(() => [])
    lastEntries = entries.filter(entry => entry.startsWith('.database-risudat-'))
    if (lastEntries.length === 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Full backup database spools were not cleaned: ${lastEntries.join(', ')}`)
}

async function waitForSnapshotCount(
  client: RisuClient,
  expectedCount: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await client.fetch('/api/db/snapshots')
    expect(response.status).toBe(200)
    const body = await response.json() as { snapshots: Array<{ key: string }> }
    if (body.snapshots.length === expectedCount) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${expectedCount} automatic snapshot(s)`)
}

async function startImport(client: RisuClient, backup: Buffer): Promise<Response> {
  const prepared = await client.fetch('/api/backup/import/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: backup.byteLength }),
  })
  expect(prepared.status).toBe(200)
  await prepared.text()
  return client.fetch('/api/backup/import', {
    method: 'POST',
    headers: { 'content-type': 'application/x-risu-backup' },
    body: new Uint8Array(backup),
  })
}

function entriesByName(archive: Buffer): Map<string, Buffer> {
  return new Map(decodeBackup(archive).map(entry => [entry.name, entry.data]))
}

function jsonStringBytes(size: number, fill: number): Buffer {
  const value = Buffer.alloc(size, fill)
  value[0] = 0x22
  value[value.length - 1] = 0x22
  return value
}

function encodeRisuSaveBlock(
  type: number,
  name: string,
  value: unknown,
  compression = false,
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

function encodeUiDatabase(options: { compression?: boolean; payload?: string } = {}): Buffer {
  const compression = options.compression ?? false
  return Buffer.concat([
    Buffer.from('RISUSAVE\0', 'utf-8'),
    encodeRisuSaveBlock(1, 'root', {
      optimizePluginMemory: false,
      apiType: 'openai',
      personas: [],
      botPresetsId: 0,
      selectedCharacter: 0,
      uiBlockPayload: options.payload ?? 'ordinary-ui-write',
    }, compression),
    encodeRisuSaveBlock(4, 'preset', [{ id: 'preset-1', name: 'Preset' }], compression),
    encodeRisuSaveBlock(5, 'modules', [], compression),
    encodeRisuSaveBlock(9, 'plugins', [], compression),
    encodeRisuSaveBlock(11, 'pluginStorage', {}, compression),
    encodeRisuSaveBlock(2, 'character-1', {
      chaId: 'character-1',
      name: 'UI block character',
      chats: [],
    }, compression),
    encodeRisuSaveBlock(0, 'config', { version: 1 }, compression),
  ])
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  typeBytes.copy(output, 4)
  data.copy(output, 8)
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length)
  return output
}

function solidPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  const rowBytes = width * 3 + 1
  for (let row = 0; row < height; row++) {
    const start = row * rowBytes
    raw[start] = 0
    for (let offset = start + 1; offset < start + rowBytes; offset += 3) {
      raw[offset] = 0xe0
      raw[offset + 1] = 0x80
      raw[offset + 2] = 0x20
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pluginStorageKey(rawKey: string): string {
  return `pluginsave/${Buffer.from(rawKey, 'utf-8').toString('base64url')}.json`
}

function expectCoherentEpoch(
  archive: Buffer,
  epochs: Record<'old' | 'new', { asset: Buffer; inlay: Buffer }>,
): 'old' | 'new' {
  const entries = entriesByName(archive)
  const database = decodeRisuDat(entries.get('database.risudat')!)
  const epoch = database.fullExportEpoch as 'old' | 'new'
  expect(['old', 'new']).toContain(epoch)
  expect(entries.get('epoch.bin')).toEqual(epochs[epoch].asset)
  expect(entries.get('inlay/epoch.bin')).toEqual(epochs[epoch].inlay)
  expect(JSON.parse(entries.get('inlay_sidecar/epoch')!.toString('utf-8'))).toMatchObject({
    name: `${epoch}-inlay`,
  })
  expect(JSON.parse(entries.get('inlay_meta/epoch')!.toString('utf-8'))).toEqual({ epoch })
  return epoch
}

async function serverSavedArchive(server: ServerHandle, response: Response): Promise<Buffer> {
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

async function readRssBytes(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`, 'utf-8')
  const kib = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0)
  return kib * 1024
}

async function withPeakRss<T>(server: ServerHandle, operation: () => Promise<T>): Promise<{
  result: T
  increase: number
}> {
  const baseline = await readRssBytes(server.pid)
  let peak = baseline
  let stopped = false
  const sampler = (async () => {
    while (!stopped) {
      peak = Math.max(peak, await readRssBytes(server.pid))
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  })()
  try {
    const result = await operation()
    peak = Math.max(peak, await readRssBytes(server.pid))
    return { result, increase: peak - baseline }
  } finally {
    stopped = true
    await sampler
  }
}

describe('full backup point-in-time filesystem pins', () => {
  test.each([false, true])('exports an ordinary UI-written RISUSAVE block database (gzip=%s)', async compression => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
    const uiDatabase = encodeUiDatabase({ compression })
    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': DB_BLOB_HEX,
      },
      body: new Uint8Array(uiDatabase),
    })
    expect(write.status).toBe(200)
    const archive = entriesByName(await client.exportBackup())
    const database = decodeRisuDat(archive.get('database.risudat')!) as {
      uiBlockPayload: string
      characters: Array<{ chaId: string; name: string }>
    }
    expect(database.uiBlockPayload).toBe('ordinary-ui-write')
    expect(database.characters).toEqual([
      expect.objectContaining({ chaId: 'character-1', name: 'UI block character' }),
    ])
    await waitForNoFullExportPins(server.cwd)
  })

  test('a 52 MiB gzip UI ROOT block exports within the bounded RSS envelope', async () => {
    const server = await spawnServer({
      env: { RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES: String(128 * MIB) },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
    const payload = 'd'.repeat(52 * MIB)
    const uiDatabase = encodeUiDatabase({ compression: true, payload })
    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': DB_BLOB_HEX,
      },
      body: new Uint8Array(uiDatabase),
    })
    expect(write.status).toBe(200)
    // Automatic snapshots intentionally run after /api/write responds. Keep
    // their assembly outside the export-only RSS measurement below.
    await waitForSnapshotCount(client, 1)

    const exported = await withPeakRss(server, () => client.exportBackup())
    expect(exported.increase).toBeLessThan(48 * MIB)
    const database = decodeRisuDat(
      entriesByName(exported.result).get('database.risudat')!,
    ) as { uiBlockPayload: string }
    expect(database.uiBlockPayload.length).toBe(payload.length)
    expect(database.uiBlockPayload[0]).toBe('d')
    await waitForNoFullExportPins(server.cwd)
  }, 120_000)

  test('full download and server save wait for an import and export one DB/assets/inlays epoch', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_BACKUP_IMPORT_TEST_GATE_DIR: 'import-gate' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const epochs = {
      old: { asset: Buffer.from('old-asset'), inlay: Buffer.from('old-inlay') },
      new: { asset: Buffer.from('new-asset'), inlay: Buffer.from('new-inlay') },
    }
    expect((await client.importBackup(epochBackup('old', epochs.old.asset, epochs.old.inlay))).ok)
      .toBe(true)

    const gateDir = path.join(server.cwd, 'import-gate')
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    const importing = startImport(
      client,
      epochBackup('new', epochs.new.asset, epochs.new.inlay),
    )
    await waitForFile(path.join(gateDir, 'entered'))

    let downloadSettled = false
    let serverSaveSettled = false
    const downloading = client.fetch('/api/backup/export').then(response => {
      downloadSettled = true
      return response
    })
    const saving = client.fetch('/api/backup/server/save', { method: 'POST' }).then(response => {
      serverSaveSettled = true
      return response
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(downloadSettled).toBe(false)
    expect(serverSaveSettled).toBe(false)

    await writeFile(path.join(gateDir, 'release'), '')
    const importResponse = await importing
    expect(importResponse.status).toBe(200)
    await expect(importResponse.json()).resolves.toMatchObject({ ok: true })

    const downloadResponse = await downloading
    expect(downloadResponse.status).toBe(200)
    const downloaded = Buffer.from(await downloadResponse.arrayBuffer())
    const saved = await serverSavedArchive(server, await saving)
    expect(expectCoherentEpoch(downloaded, epochs)).toBe('new')
    expect(expectCoherentEpoch(saved, epochs)).toBe('new')
    await waitForNoFullExportPins(server.cwd)
  }, 60_000)

  test('disconnects cancel both route waiters behind an import without late pins', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_BACKUP_IMPORT_TEST_GATE_DIR: 'import-gate' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const old = epochBackup('old', Buffer.from('old-asset'), Buffer.from('old-inlay'))
    const next = epochBackup('new', Buffer.from('new-asset'), Buffer.from('new-inlay'))
    expect((await client.importBackup(old)).ok).toBe(true)

    const gateDir = path.join(server.cwd, 'import-gate')
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    const importing = startImport(client, next)
    await waitForFile(path.join(gateDir, 'entered'))

    const downloadAbort = new AbortController()
    const saveAbort = new AbortController()
    const downloading = client.fetch('/api/backup/export', { signal: downloadAbort.signal })
    const saving = client.fetch('/api/backup/server/save', {
      method: 'POST',
      signal: saveAbort.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    downloadAbort.abort()
    saveAbort.abort()
    await expect(downloading).rejects.toMatchObject({ name: 'AbortError' })
    await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
    await waitForNoFullExportPins(server.cwd)

    await writeFile(path.join(gateDir, 'release'), '')
    const importResponse = await importing
    await importResponse.text()
    expect(importResponse.status).toBe(200)
    // Cancelled queue waiters must not wake after release and create artifacts.
    await new Promise(resolve => setTimeout(resolve, 200))
    await waitForNoFullExportPins(server.cwd)

    const spoolDir = path.join(server.cwd, 'save', '.partial-export-spool')
    const orphan = path.join(spoolDir, '.full-export-orphan')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, '00000000.pin'), 'orphan')
    await server.restart()
    expect(await readdir(spoolDir)).not.toContain('.full-export-orphan')
  }, 60_000)

  test('large filesystem inputs stay bounded and private pins are removed', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const asset = Buffer.alloc(56 * MIB, 0x61)
    const inlay = Buffer.alloc(8 * MIB, 0x69)
    expect((await client.importBackup(epochBackup('new', asset, inlay))).ok).toBe(true)

    const downloaded = await withPeakRss(server, async () => {
      const response = await client.fetch('/api/backup/export')
      expect(response.status).toBe(200)
      return Buffer.from(await response.arrayBuffer())
    })
    const downloadEntries = entriesByName(downloaded.result)
    expect(downloadEntries.get('epoch.bin')?.equals(asset)).toBe(true)
    expect(downloadEntries.get('inlay/epoch.bin')?.equals(inlay)).toBe(true)
    expect(downloaded.increase).toBeLessThan(48 * MIB)
    await waitForNoFullExportPins(server.cwd)

    const saved = await withPeakRss(server, async () => {
      return serverSavedArchive(
        server,
        await client.fetch('/api/backup/server/save', { method: 'POST' }),
      )
    })
    const savedEntries = entriesByName(saved.result)
    expect(savedEntries.get('epoch.bin')?.equals(asset)).toBe(true)
    expect(savedEntries.get('inlay/epoch.bin')?.equals(inlay)).toBe(true)
    expect(saved.increase).toBeLessThan(48 * MIB)
    await waitForNoFullExportPins(server.cwd)
  }, 120_000)

  test('legacy hash-shaped asset names pin authoritative bytes without digest inference', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const legacyName = `${'0'.repeat(64)}.png`
    const legacyBytes = Buffer.from('supported-legacy-bytes-that-do-not-hash-to-the-name')
    const seed = Buffer.concat([
      createSeedBackup(),
      encodeBackup([{ name: legacyName, data: legacyBytes }]),
    ])
    expect(await client.importBackup(seed)).toMatchObject({ ok: true })

    const downloadResponse = await client.fetch('/api/backup/export')
    expect(downloadResponse.status).toBe(200)
    const downloaded = Buffer.from(await downloadResponse.arrayBuffer())
    expect(entriesByName(downloaded).get(legacyName)).toEqual(legacyBytes)

    const saved = await serverSavedArchive(
      server,
      await client.fetch('/api/backup/server/save', { method: 'POST' }),
    )
    expect(entriesByName(saved).get(legacyName)).toEqual(legacyBytes)

    for (const archive of [downloaded, saved]) {
      const destination = await spawnServer()
      servers.push(destination)
      const destinationClient = await createClient(destination.port, destination.password)
      expect((await destinationClient.importBackup(archive)).ok).toBe(true)
      const reexported = await destinationClient.exportBackup()
      expect(entriesByName(reexported).get(legacyName)).toEqual(legacyBytes)
    }
    await waitForNoFullExportPins(server.cwd)
  }, 60_000)

  test('a large external chat row is folded by pages without a whole-row heap spike', async () => {
    const server = await spawnServer({
      env: { RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES: String(128 * MIB) },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const message = 'h'.repeat(52 * MIB)
    const seed = createSeedBackup({
      databaseFields: {
        characters: [{
          chaId: 'large-chat-character',
          name: 'Large chat character',
          chatFolders: [{ id: 'folder-1', name: 'Folder' }],
          chats: [{
            id: 'large-chat',
            name: 'Large chat',
            lastDate: 123456,
            folderId: 'folder-1',
            modules: ['module-1'],
            message: [{ role: 'user', data: message }],
            localLore: [],
            scriptstate: {},
            note: '',
          }],
        }],
      },
    })
    expect((await client.importBackup(seed)).ok).toBe(true)

    const exported = await withPeakRss(server, () => client.exportBackup())
    expect(exported.increase).toBeLessThan(48 * MIB)
    const database = decodeRisuDat(
      entriesByName(exported.result).get('database.risudat')!,
    ) as {
      characters: Array<{ chats: Array<Record<string, unknown>> }>
    }
    const chat = database.characters[0].chats[0] as {
      id: string
      name: string
      lastDate: number
      folderId: string
      modules: string[]
      message: Array<{ data: string }>
      _stub?: boolean
    }
    expect(chat).toMatchObject({
      id: 'large-chat',
      name: 'Large chat',
      lastDate: 123456,
      folderId: 'folder-1',
      modules: ['module-1'],
    })
    expect(chat._stub).toBeUndefined()
    expect(chat.message[0].data.length).toBe(message.length)
    await waitForNoFullExportPins(server.cwd)
  }, 120_000)

  test('same-name same-size asset and inlay import waits for one coherent filesystem cut', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_TEST_FULL_EXPORT_FILE_PAGE_DELAY_MS: '2' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const oldAsset = Buffer.alloc(4 * MIB, 0x31)
    const oldInlay = Buffer.alloc(4 * MIB, 0x41)
    const newAsset = Buffer.alloc(oldAsset.length, 0x32)
    const newInlay = Buffer.alloc(oldInlay.length, 0x42)
    expect((await client.importBackup(epochBackup('old', oldAsset, oldInlay))).ok).toBe(true)

    const exporting = client.fetch('/api/backup/export').then(async response => {
      expect(response.status).toBe(200)
      return Buffer.from(await response.arrayBuffer())
    })
    await waitForFullExportPin(server.cwd)
    let importSettled = false
    const importing = startImport(
      client,
      epochBackup('new', newAsset, newInlay),
    ).then(response => {
      importSettled = true
      return response
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(importSettled).toBe(false)

    const archive = await exporting
    expect(expectCoherentEpoch(archive, {
      old: { asset: oldAsset, inlay: oldInlay },
      new: { asset: newAsset, inlay: newInlay },
    })).toBe('old')
    const importResponse = await importing
    expect(importResponse.status).toBe(200)
    await expect(importResponse.json()).resolves.toMatchObject({ ok: true })
    const next = await client.exportBackup()
    expect(expectCoherentEpoch(next, {
      old: { asset: oldAsset, inlay: oldInlay },
      new: { asset: newAsset, inlay: newInlay },
    })).toBe('new')
    await waitForNoFullExportPins(server.cwd)
  }, 90_000)

  test('inlay compression publication waits behind a filesystem pin and exports one sidecar epoch', async () => {
    const server = await spawnServer({
      env: {
        POCKETRISU_TEST_FULL_EXPORT_DURING_PIN_GATE_DIR: 'pin-gate',
        POCKETRISU_TEST_INLAY_COMPRESS_BEFORE_COMMIT_GATE_DIR: 'compress-gate',
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const png = solidPng(256, 256)
    const seed = Buffer.concat([
      createSeedBackup(),
      encodeBackup([
        { name: 'inlay/compress.png', data: png },
        {
          name: 'inlay_sidecar/compress',
          data: Buffer.from(JSON.stringify({ ext: 'png', name: 'compress', type: 'image' })),
        },
      ]),
    ])
    expect((await client.importBackup(seed)).ok).toBe(true)

    const pinGateDir = path.join(server.cwd, 'pin-gate')
    const compressGateDir = path.join(server.cwd, 'compress-gate')
    await Promise.all([
      mkdir(pinGateDir, { recursive: true }),
      mkdir(compressGateDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(pinGateDir, 'hold'), ''),
      writeFile(path.join(compressGateDir, 'hold'), ''),
    ])
    const sessionResponse = await client.fetch('/api/session', { method: 'POST' })
    expect(sessionResponse.status).toBe(200)
    const sessionCookie = sessionResponse.headers.get('set-cookie')!.split(';', 1)[0]
    const exporting = new Promise<Buffer>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: server.port,
        path: '/api/backup/export',
        method: 'GET',
        headers: { 'risu-auth': client.token },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Raw full export failed with ${response.statusCode}`))
          } else {
            resolve(Buffer.concat(chunks))
          }
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
    await waitForFile(path.join(pinGateDir, 'entered'))

    const compressionResponse = client.fetch('/api/inlays/compress', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: sessionCookie,
      },
      body: JSON.stringify({ quality: 80 }),
    })
    let compressionSettled = false
    const compressionDone = compressionResponse.then(async response => {
      expect(response.status).toBe(200)
      const text = await response.text()
      compressionSettled = true
      return text
    })
    await waitForFile(path.join(compressGateDir, 'entered'))
    await writeFile(path.join(compressGateDir, 'release'), '')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(compressionSettled).toBe(false)

    await writeFile(path.join(pinGateDir, 'release'), '')

    const oldArchive = entriesByName(await exporting)
    expect(oldArchive.get('inlay/compress.png')).toEqual(png)
    expect(oldArchive.has('inlay/compress.webp')).toBe(false)
    expect(JSON.parse(oldArchive.get('inlay_sidecar/compress')!.toString('utf-8')).ext)
      .toBe('png')

    const compressionEvents = await compressionDone
    expect(compressionEvents).toContain('"type":"done"')
    const nextArchive = entriesByName(await client.exportBackup())
    expect(nextArchive.has('inlay/compress.png')).toBe(false)
    expect(nextArchive.has('inlay/compress.webp')).toBe(true)
    expect(JSON.parse(nextArchive.get('inlay_sidecar/compress')!.toString('utf-8')).ext)
      .toBe('webp')
    await waitForNoFullExportPins(server.cwd)
  }, 120_000)

  test('same-volume reservations are exact and reject concurrent overcommit atomically', async () => {
    const sharedEnv = {
      POCKETRISU_TEST_FULL_EXPORT_PIN_VOLUME: 'shared',
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_VOLUME: 'shared',
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: '0',
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: '0',
    }
    const server = await spawnServer({ env: sharedEnv })
    servers.push(server)
    let client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

    const probe = await client.fetch('/api/backup/export')
    expect(probe.status).toBe(507)
    const probeBody = await probe.json() as { required: number; roles: string[] }
    expect(probeBody.roles).toEqual(['PIN', 'DATABASE'])
    const required = probeBody.required
    expect(required).toBeGreaterThan(0)

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(required - 1),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(required - 1),
    })
    client = await createClient(server.port, server.password)
    expect((await client.fetch('/api/backup/export')).status).toBe(507)

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(required),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(required),
    })
    client = await createClient(server.port, server.password)
    const exact = await client.fetch('/api/backup/export')
    expect(exact.status).toBe(200)
    await exact.arrayBuffer()
    await waitForNoFullExportPins(server.cwd)

    const gateDir = path.join(server.cwd, 'full-export-gate')
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    const concurrentAvailable = required + Math.max(1, Math.floor(required / 2))
    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(concurrentAvailable),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(concurrentAvailable),
      POCKETRISU_TEST_FULL_EXPORT_AFTER_PIN_GATE_DIR: gateDir,
    })
    client = await createClient(server.port, server.password)
    const first = client.fetch('/api/backup/export')
    await waitForFile(path.join(gateDir, 'entered'))
    const second = await client.fetch('/api/backup/export')
    expect(second.status).toBe(507)
    await expect(second.json()).resolves.toMatchObject({
      required,
      reserved: required,
      roles: ['PIN', 'DATABASE'],
    })
    await writeFile(path.join(gateDir, 'release'), '')
    const firstResponse = await first
    expect(firstResponse.status).toBe(200)
    await firstResponse.arrayBuffer()
    await waitForNoFullExportPins(server.cwd)
  }, 60_000)

  test('separate-volume reservations enforce each exact requirement independently', async () => {
    const server = await spawnServer({
      env: {
        POCKETRISU_TEST_FULL_EXPORT_PIN_VOLUME: 'pin-volume',
        POCKETRISU_TEST_FULL_EXPORT_DATABASE_VOLUME: 'database-volume',
        POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: '0',
        POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: '0',
      },
    })
    servers.push(server)
    let client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

    const pinProbe = await client.fetch('/api/backup/export')
    expect(pinProbe.status).toBe(507)
    const pinBody = await pinProbe.json() as { required: number; roles: string[] }
    expect(pinBody.roles).toEqual(['PIN'])

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(pinBody.required),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: '0',
    })
    client = await createClient(server.port, server.password)
    const databaseProbe = await client.fetch('/api/backup/export')
    expect(databaseProbe.status).toBe(507)
    const databaseBody = await databaseProbe.json() as { required: number; roles: string[] }
    expect(databaseBody.roles).toEqual(['DATABASE'])

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(pinBody.required),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(databaseBody.required - 1),
    })
    client = await createClient(server.port, server.password)
    expect((await client.fetch('/api/backup/export')).status).toBe(507)

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(pinBody.required),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(databaseBody.required),
    })
    client = await createClient(server.port, server.password)
    const exact = await client.fetch('/api/backup/export')
    expect(exact.status).toBe(200)
    await exact.arrayBuffer()
    await waitForNoFullExportPins(server.cwd)
  }, 60_000)

  test('server saves reserve the final archive atomically on shared and separate volumes', async () => {
    const server = await spawnServer({
      env: {
        POCKETRISU_TEST_FULL_EXPORT_PIN_VOLUME: 'all-shared',
        POCKETRISU_TEST_FULL_EXPORT_DATABASE_VOLUME: 'all-shared',
        POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_VOLUME: 'all-shared',
        POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: '0',
        POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: '0',
        POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_AVAILABLE_BYTES: '0',
      },
    })
    servers.push(server)
    let client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

    const sharedProbe = await client.fetch('/api/backup/server/save', { method: 'POST' })
    expect(sharedProbe.status).toBe(507)
    const shared = await sharedProbe.json() as { required: number; roles: string[] }
    expect(shared.roles).toEqual(['PIN', 'DATABASE', 'ARCHIVE'])

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(shared.required - 1),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(shared.required - 1),
      POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_AVAILABLE_BYTES: String(shared.required - 1),
    })
    client = await createClient(server.port, server.password)
    expect((await client.fetch('/api/backup/server/save', { method: 'POST' })).status).toBe(507)

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(shared.required),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(shared.required),
      POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_AVAILABLE_BYTES: String(shared.required),
    })
    client = await createClient(server.port, server.password)
    const exact = await serverSavedArchive(
      server,
      await client.fetch('/api/backup/server/save', { method: 'POST' }),
    )
    expect(entriesByName(exact).has('database.risudat')).toBe(true)
    await waitForNoFullExportPins(server.cwd)

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_VOLUME: 'pin-db',
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_VOLUME: 'pin-db',
      POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_VOLUME: 'archive-only',
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(1024 * MIB),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(1024 * MIB),
      POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_AVAILABLE_BYTES: '0',
    })
    client = await createClient(server.port, server.password)
    const archiveProbe = await client.fetch('/api/backup/server/save', { method: 'POST' })
    expect(archiveProbe.status).toBe(507)
    const archive = await archiveProbe.json() as { required: number; roles: string[] }
    expect(archive.roles).toEqual(['ARCHIVE'])

    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PIN_VOLUME: 'pin-db',
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_VOLUME: 'pin-db',
      POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_VOLUME: 'archive-only',
      POCKETRISU_TEST_FULL_EXPORT_PIN_AVAILABLE_BYTES: String(1024 * MIB),
      POCKETRISU_TEST_FULL_EXPORT_DATABASE_AVAILABLE_BYTES: String(1024 * MIB),
      POCKETRISU_TEST_FULL_EXPORT_ARCHIVE_AVAILABLE_BYTES: String(archive.required),
    })
    client = await createClient(server.port, server.password)
    const separateExact = await serverSavedArchive(
      server,
      await client.fetch('/api/backup/server/save', { method: 'POST' }),
    )
    expect(entriesByName(separateExact).has('database.risudat')).toBe(true)
    await waitForNoFullExportPins(server.cwd)
  }, 90_000)

  test('large chunked plugin and cold rows pin by pages with integrity and cancellation', async () => {
    const server = await spawnServer({
      env: { RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES: String(128 * MIB) },
    })
    servers.push(server)
    let client = await createClient(server.port, server.password)
    const generation = 'full-export-large-generation'
    const pluginKey = pluginStorageKey('full-export-large-value')
    const pluginValue = jsonStringBytes(52 * MIB, 0x70)
    const coldValue = jsonStringBytes(52 * MIB, 0x63)
    const manifest = {
      version: 1,
      generation,
      valueKeys: [pluginKey],
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
        { name: pluginKey, data: pluginValue },
        { name: 'plugin-storage/manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: 'coldstorage/full-export-large.json', data: coldValue },
      ]),
    ])
    expect(await client.importBackup(seed)).toMatchObject({ ok: true })

    const downloaded = await withPeakRss(server, async () => {
      const response = await client.fetch('/api/backup/export')
      expect(response.status).toBe(200)
      return Buffer.from(await response.arrayBuffer())
    })
    const downloadEntries = entriesByName(downloaded.result)
    expect(downloadEntries.get(pluginKey)?.equals(pluginValue)).toBe(true)
    expect(downloadEntries.get('coldstorage/full-export-large.json')?.equals(coldValue)).toBe(true)
    expect(downloaded.increase).toBeLessThan(48 * MIB)
    await waitForNoFullExportPins(server.cwd)

    const saved = await withPeakRss(server, async () => serverSavedArchive(
      server,
      await client.fetch('/api/backup/server/save', { method: 'POST' }),
    ))
    const savedEntries = entriesByName(saved.result)
    expect(savedEntries.get(pluginKey)?.equals(pluginValue)).toBe(true)
    expect(savedEntries.get('coldstorage/full-export-large.json')?.equals(coldValue)).toBe(true)
    expect(saved.increase).toBeLessThan(48 * MIB)
    await waitForNoFullExportPins(server.cwd)

    const upstream = await withPeakRss(server, async () => {
      const response = await client.fetch('/api/backup/export?target=upstream')
      expect(response.status).toBe(200)
      return Buffer.from(await response.arrayBuffer())
    })
    const upstreamEntries = entriesByName(upstream.result)
    expect(upstreamEntries.has(pluginKey)).toBe(false)
    const upstreamDatabase = decodeRisuDat(upstreamEntries.get('database.risudat')!) as {
      pluginCustomStorage: Record<string, string>
    }
    expect(upstreamDatabase.pluginCustomStorage['full-export-large-value'].length)
      .toBe(pluginValue.length - 2)
    expect(upstreamDatabase.pluginCustomStorage['full-export-large-value'][0]).toBe('p')
    expect(upstream.increase).toBeLessThan(48 * MIB)
    await waitForNoFullExportPins(server.cwd)

    const transcodeGate = path.join(server.cwd, 'plugin-transcode-gate')
    await mkdir(transcodeGate, { recursive: true })
    await writeFile(path.join(transcodeGate, 'hold'), '')
    await server.restart({
      POCKETRISU_TEST_FULL_EXPORT_PLUGIN_TRANSCODE_GATE_DIR: transcodeGate,
    })
    client = await createClient(server.port, server.password)
    const transcodeRequest = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/backup/export?target=upstream',
      method: 'GET',
      headers: { 'risu-auth': client.token },
    })
    transcodeRequest.on('error', () => {})
    const transcodeSocketReady = new Promise<import('node:net').Socket>(resolve => {
      transcodeRequest.once('socket', resolve)
    })
    transcodeRequest.end()
    const transcodeSocket = await transcodeSocketReady
    await waitForFile(path.join(transcodeGate, 'entered'))
    const transcodeSocketClosed = new Promise<void>(resolve => {
      transcodeSocket.once('close', () => resolve())
    })
    transcodeSocket.destroy()
    await transcodeSocketClosed
    await waitForNoFullExportPins(server.cwd)
    await waitForNoDatabaseSpools(server)
    expect((await client.fetch('/api/db/stats')).status).toBe(200)

    const destination = await spawnServer({
      env: { RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES: String(128 * MIB) },
    })
    servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(downloaded.result)).ok).toBe(true)

    await server.restart({ POCKETRISU_TEST_FULL_EXPORT_PAGE_DELAY_MS: '2' })
    client = await createClient(server.port, server.password)
    const request = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/backup/export',
      method: 'GET',
      headers: { 'risu-auth': client.token },
    })
    request.on('error', () => {})
    const socketReady = new Promise<import('node:net').Socket>((resolve) => {
      request.once('socket', resolve)
    })
    request.end()
    const socket = await socketReady
    await waitForFullExportPin(server.cwd)
    const socketClosed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    socket.destroy()
    await socketClosed
    await waitForNoFullExportPins(server.cwd)

    // The cancelled gzip source stream must not crash the server.
    expect((await client.fetch('/api/db/stats')).status).toBe(200)

    const publishGate = path.join(server.cwd, 'server-save-publish-gate')
    await mkdir(publishGate, { recursive: true })
    await writeFile(path.join(publishGate, 'hold'), '')
    const backupsBefore = (await readdir(path.join(server.cwd, 'backups'))).sort()
    await server.restart({
      POCKETRISU_TEST_SERVER_BACKUP_BEFORE_PUBLISH_GATE_DIR: publishGate,
    })
    client = await createClient(server.port, server.password)
    const saveRequest = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/backup/server/save',
      method: 'POST',
      headers: { 'risu-auth': client.token },
    })
    saveRequest.on('error', () => {})
    const saveSocketReady = new Promise<import('node:net').Socket>((resolve) => {
      saveRequest.once('socket', resolve)
    })
    saveRequest.end()
    const saveSocket = await saveSocketReady
    await waitForFile(path.join(publishGate, 'entered'))
    const saveSocketClosed = new Promise<void>(resolve => {
      saveSocket.once('close', () => resolve())
    })
    saveSocket.destroy()
    await saveSocketClosed
    await waitForNoFullExportPins(server.cwd)
    expect((await readdir(path.join(server.cwd, 'backups'))).sort()).toEqual(backupsBefore)
    expect((await client.fetch('/api/db/stats')).status).toBe(200)
  }, 180_000)
})
