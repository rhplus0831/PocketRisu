/**
 * Backup round-trip integration tests.
 *
 * Flow:  seed → import → export → import(new server) → export → compare
 *
 * These tests spin up real server instances in temp directories, so they
 * exercise the actual backup/import code paths including SQLite, KV layer,
 * and binary encoding.
 */
import { describe, test, expect, afterAll } from 'vitest'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { link, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { normalizeBackup, fingerprintAssets } from './helpers/normalize.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'

// Track servers so we can clean them all up even if a test fails.
const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

function hashAssetName(value: Buffer, ext = 'png'): string {
  return `${createHash('sha256').update(value).digest('hex')}.${ext}`
}

function readKvValue(cwd: string, key: string): Buffer | null {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: Buffer } | undefined
    return row ? Buffer.from(row.value) : null
  } finally {
    db.close()
  }
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

// ─── Smoke ──────────────────────────────────────────────────────────────────

describe('server smoke', () => {
  test('starts and responds to login', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    expect(client.token).toBeTruthy()
  })

  test('backup path config rejects app-managed dirs and records safe custom dirs', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const pathInfoRes = await client.fetch('/api/backup/server/path')
    expect(pathInfoRes.status).toBe(200)
    const pathInfo = await pathInfoRes.json() as { default: string }
    const serverRoot = path.dirname(pathInfo.default)

    const managedPath = path.join(serverRoot, 'server', 'backups')
    const managedRes = await client.fetch('/api/backup/server/path', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: managedPath }),
    })
    expect(managedRes.status).toBe(400)
    const managedBody = await managedRes.json() as { error?: string }
    expect(managedBody.error).toContain('PocketRisu app files')

    const safePath = path.join(serverRoot, 'data', 'backups')
    const safeRes = await client.fetch('/api/backup/server/path', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: safePath }),
    })
    expect(safeRes.status).toBe(200)
    const safeBody = await safeRes.json() as { path: string; isDefault: boolean }
    expect(safeBody.path).toBe(safePath)
    expect(safeBody.isDefault).toBe(false)

    const marker = await readFile(path.join(srv.cwd, 'save', '__backup_path'), 'utf-8')
    expect(marker.trim()).toBe(safePath)
  })
})

// ─── Round-trip ─────────────────────────────────────────────────────────────

describe('backup round-trip', () => {
  test('round-trip preserves core database', async () => {
    // 1. Server A: import seed, export
    const srvA = await spawnServer()
    servers.push(srvA)
    const clientA = await createClient(srvA.port, srvA.password)

    const seed = createSeedBackup({ characterCount: 2, chatsPerCharacter: 2, messagesPerChat: 3 })
    const importResult = await clientA.importBackup(seed)
    expect(importResult.ok).toBe(true)

    const exportA = await clientA.exportBackup()
    expect(exportA.length).toBeGreaterThan(0)

    // 2. Server B: import A's export, re-export
    const srvB = await spawnServer()
    servers.push(srvB)
    const clientB = await createClient(srvB.port, srvB.password)

    const importB = await clientB.importBackup(exportA)
    expect(importB.ok).toBe(true)

    const exportB = await clientB.exportBackup()

    // 3. Compare normalized databases
    const normA = normalizeBackup(exportA)
    const normB = normalizeBackup(exportB)

    expect(normB.normalized.characterCount).toBe(normA.normalized.characterCount)
    expect(normB.normalized.characters).toEqual(normA.normalized.characters)
    expect(normB.normalized.personaCount).toBe(normA.normalized.personaCount)
    // Setting keys may gain defaults from the server, but seed keys must survive
    for (const key of normA.normalized.settingKeys) {
      expect(normB.normalized.settingKeys).toContain(key)
    }
    // Message content spot-check
    for (let i = 0; i < normA.normalized.characters.length; i++) {
      expect(normB.normalized.characters[i].firstMessages)
        .toEqual(normA.normalized.characters[i].firstMessages)
    }
  })

  test('round-trip with multiple characters preserves message counts', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 3, chatsPerCharacter: 3, messagesPerChat: 5 })
    await client.importBackup(seed)
    const exported = await client.exportBackup()

    const { normalized } = normalizeBackup(exported)
    expect(normalized.characterCount).toBe(3)
    for (const char of normalized.characters) {
      expect(char.chatCount).toBe(3)
      for (const count of char.messageCounts) {
        expect(count).toBe(5)
      }
    }
  })
})

// ─── Asset round-trip ──────────────────────────────────────────────────────

describe('asset round-trip', () => {
  test('asset count and payload survive import and re-export', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 2, includeAssets: true })
    const beforeFingerprints = fingerprintAssets(seed)
    expect(beforeFingerprints.length).toBe(2)

    await client.importBackup(seed)
    const exported = await client.exportBackup()
    const afterFingerprints = fingerprintAssets(exported)

    // Both count and content (sha256) must match
    expect(afterFingerprints).toEqual(beforeFingerprints)
  })

  test('hash-named filesystem and unsafe KV assets preserve bytes and placement across servers', async () => {
    const hashedValue = Buffer.from('hash-addressed png bytes')
    const hashedName = hashAssetName(hashedValue)
    const unsafeName = 'unsafe asset name.png'
    const unsafeValue = Buffer.from('legacy unsafe asset bytes')
    const seed = Buffer.concat([
      createSeedBackup({ characterCount: 1 }),
      encodeBackup([
        { name: hashedName, data: hashedValue },
        { name: unsafeName, data: unsafeValue },
      ]),
    ])

    const srvA = await spawnServer()
    servers.push(srvA)
    const clientA = await createClient(srvA.port, srvA.password)
    expect((await clientA.importBackup(seed)).ok).toBe(true)

    expect(await readFile(path.join(srvA.cwd, 'save', 'assets', hashedName))).toEqual(hashedValue)
    expect(readKvValue(srvA.cwd, `assets/${hashedName}`)).toBeNull()
    await expectMissing(path.join(srvA.cwd, 'save', 'assets', unsafeName))
    expect(readKvValue(srvA.cwd, `assets/${unsafeName}`)).toEqual(unsafeValue)

    const exportA = await clientA.exportBackup()
    const entriesA = new Map(decodeBackup(exportA).map((entry) => [entry.name, entry.data]))
    expect(entriesA.get(hashedName)).toEqual(hashedValue)
    expect(entriesA.get(unsafeName)).toEqual(unsafeValue)

    const srvB = await spawnServer()
    servers.push(srvB)
    const clientB = await createClient(srvB.port, srvB.password)
    expect((await clientB.importBackup(exportA)).ok).toBe(true)

    expect(await readFile(path.join(srvB.cwd, 'save', 'assets', hashedName))).toEqual(hashedValue)
    expect(readKvValue(srvB.cwd, `assets/${hashedName}`)).toBeNull()
    await expectMissing(path.join(srvB.cwd, 'save', 'assets', unsafeName))
    expect(readKvValue(srvB.cwd, `assets/${unsafeName}`)).toEqual(unsafeValue)

    const entriesB = new Map(decodeBackup(await clientB.exportBackup()).map((entry) => [entry.name, entry.data]))
    expect(entriesB.get(hashedName)).toEqual(hashedValue)
    expect(entriesB.get(unsafeName)).toEqual(unsafeValue)
  })

  test('legacy directory and ZIP imports stage safe assets and keep unsafe names in KV', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const dbValue = decodeBackup(createSeedBackup({ characterCount: 1 }))
      .find((entry) => entry.name === 'database.risudat')!.data
    const hexName = (key: string) => Buffer.from(key, 'utf-8').toString('hex')

    const dirSafeValue = Buffer.from('directory safe asset')
    const dirSafeName = hashAssetName(dirSafeValue)
    const dirUnsafeName = 'directory unsafe asset.png'
    const dirUnsafeValue = Buffer.from('directory unsafe bytes')
    const sourceDir = path.join(srv.cwd, 'legacy-save-source')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, hexName('database/database.bin')), dbValue)
    await writeFile(path.join(sourceDir, hexName(`assets/${dirSafeName}`)), dirSafeValue)
    await writeFile(path.join(sourceDir, hexName(`assets/${dirUnsafeName}`)), dirUnsafeValue)

    const directoryRes = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sourceDir }),
    })
    expect(directoryRes.status).toBe(200)
    expect(await readFile(path.join(srv.cwd, 'save', 'assets', dirSafeName))).toEqual(dirSafeValue)
    expect(readKvValue(srv.cwd, `assets/${dirUnsafeName}`)).toEqual(dirUnsafeValue)

    // A deliberately mismatched hash name is trusted on legacy import and
    // must still be installed verbatim (with a server warning, not rejection).
    const zipSafeName = `${'0'.repeat(64)}.webp`
    const zipSafeValue = Buffer.from('trusted mismatched legacy asset')
    const zipUnsafeName = 'zip unsafe asset.webp'
    const zipUnsafeValue = Buffer.from('zip unsafe bytes')
    const zip = Buffer.from(zipSync({
      [hexName('database/database.bin')]: new Uint8Array(dbValue),
      [hexName(`assets/${zipSafeName}`)]: new Uint8Array(zipSafeValue),
      [hexName(`assets/${zipUnsafeName}`)]: new Uint8Array(zipUnsafeValue),
    }))
    const zipRes = await client.fetch('/api/migrate/save-folder/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: new Uint8Array(zip),
    })
    expect(zipRes.status).toBe(200)

    await expectMissing(path.join(srv.cwd, 'save', 'assets', dirSafeName))
    expect(readKvValue(srv.cwd, `assets/${dirUnsafeName}`)).toBeNull()
    expect(await readFile(path.join(srv.cwd, 'save', 'assets', zipSafeName))).toEqual(zipSafeValue)
    expect(readKvValue(srv.cwd, `assets/${zipSafeName}`)).toBeNull()
    expect(readKvValue(srv.cwd, `assets/${zipUnsafeName}`)).toEqual(zipUnsafeValue)
  })
})

describe('asset upload hash verification', () => {
  test('/api/write rejects mismatches and preserves the inode on an idempotent matching write', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const value = Buffer.from('public upload bytes')
    const name = hashAssetName(value, 'webp')
    const key = `assets/${name}`
    const filePath = path.join(srv.cwd, 'save', 'assets', name)
    const encodedKey = Buffer.from(key, 'utf-8').toString('hex')

    const mismatchRes = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': encodedKey,
      },
      body: new Uint8Array(Buffer.from('wrong bytes')),
    })
    expect(mismatchRes.status).toBe(400)
    const mismatch = await mismatchRes.json() as {
      error: string; key: string; expected: string; actual: string
    }
    expect(mismatch.error).toBe('asset content does not match its SHA-256 name')
    expect(mismatch.key).toBe(key)
    expect(mismatch.expected).toBe(name.slice(0, 64))
    expect(mismatch.actual).toHaveLength(64)
    await expectMissing(filePath)

    const write = () => client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': encodedKey,
      },
      body: new Uint8Array(value),
    })
    expect((await write()).status).toBe(200)
    const linkedPath = path.join(srv.cwd, 'save', 'linked-upload.webp')
    await link(filePath, linkedPath)
    const before = await stat(filePath)

    expect((await write()).status).toBe(200)
    expect((await stat(filePath)).ino).toBe(before.ino)
    expect((await stat(linkedPath)).ino).toBe(before.ino)
    expect(await readFile(linkedPath)).toEqual(value)
  })

  test('/api/assets/bulk-write validates every entry before writing any', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const validValue = Buffer.from('valid bulk bytes')
    const invalidValue = Buffer.from('invalid bulk bytes')
    const validName = hashAssetName(validValue)
    const invalidName = `${'0'.repeat(64)}.png`
    const secondInvalidName = `${'1'.repeat(64)}.jpg`

    const res = await client.fetch('/api/assets/bulk-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { key: `assets/${validName}`, value: validValue.toString('base64') },
        { key: `assets/${invalidName}`, value: invalidValue.toString('base64') },
        { key: `assets/${secondInvalidName}`, value: invalidValue.toString('base64') },
      ]),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { keys: string[]; mismatches: Array<{ key: string }> }
    expect(body.keys).toEqual([
      `assets/${invalidName}`,
      `assets/${secondInvalidName}`,
    ])
    expect(body.mismatches.map((entry) => entry.key)).toEqual(body.keys)
    await expectMissing(path.join(srv.cwd, 'save', 'assets', validName))
    await expectMissing(path.join(srv.cwd, 'save', 'assets', invalidName))
    await expectMissing(path.join(srv.cwd, 'save', 'assets', secondInvalidName))
  })
})

// ─── Upstream-compatible export ────────────────────────────────────────────

describe('upstream-compatible backup export', () => {
  test('excludes NodeOnly-only inlay namespaces while regular export preserves them', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = Buffer.concat([
      createSeedBackup({ characterCount: 1 }),
      encodeBackup([
        { name: 'inlay/test-inlay.png', data: Buffer.from('fake-inlay-image') },
        {
          name: 'inlay_sidecar/test-inlay',
          data: Buffer.from(JSON.stringify({
            ext: 'png',
            name: 'test-inlay.png',
            type: 'image',
          })),
        },
        {
          name: 'inlay_meta/test-inlay',
          data: Buffer.from(JSON.stringify({
            createdAt: 1,
            updatedAt: 2,
            charId: 'test-char-0',
            chatId: 'chat-0-0',
          })),
        },
      ]),
    ])

    const importResult = await client.importBackup(seed)
    expect(importResult.ok).toBe(true)

    const regularNames = decodeBackup(await client.exportBackup()).map(e => e.name)
    expect(regularNames).toEqual(expect.arrayContaining([
      'database.risudat',
      'inlay/test-inlay.png',
      'inlay_sidecar/test-inlay',
      'inlay_meta/test-inlay',
    ]))

    const upstreamRes = await client.fetch('/api/backup/export?target=upstream')
    expect(upstreamRes.ok).toBe(true)
    expect(upstreamRes.headers.get('content-disposition')).toContain('-upstream.bin')

    const upstreamBackup = Buffer.from(await upstreamRes.arrayBuffer())
    const upstreamNames = decodeBackup(upstreamBackup).map(e => e.name)

    expect(upstreamNames).toContain('database.risudat')
    expect(upstreamNames.some(name => name.startsWith('inlay/'))).toBe(false)
    expect(upstreamNames.some(name => name.startsWith('inlay_sidecar/'))).toBe(false)
    expect(upstreamNames.some(name => name.startsWith('inlay_meta/'))).toBe(false)

    const regularDb = normalizeBackup(await client.exportBackup()).normalized
    const upstreamDb = normalizeBackup(upstreamBackup).normalized
    expect(upstreamDb).toEqual(regularDb)
  })
})

// ─── Content-type compatibility ────────────────────────────────────────────

describe('content-type compatibility', () => {
  test('import works with application/octet-stream', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 1 })
    const before = normalizeBackup(seed)

    // Bypass the normal importBackup (which uses x-risu-backup) and
    // send with octet-stream directly to verify the fix.
    const prepRes = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: seed.byteLength }),
    })
    expect(prepRes.ok).toBe(true)

    const impRes = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(seed),
    })
    const result = await impRes.json() as { ok: boolean }
    expect(result.ok).toBe(true)

    const exported = await client.exportBackup()
    const after = normalizeBackup(exported)
    expect(after.normalized.characterCount).toBe(before.normalized.characterCount)
    expect(after.normalized.characters).toEqual(before.normalized.characters)
  })
})

// ─── NDJSON streaming response ──────────────────────────────────────────────
//
// The NDJSON import path was added to keep the response socket alive during
// long post-upload work (WAL checkpoint, cold-storage migration, etc.) so a
// reverse proxy in front of the Node server doesn't time out and bounce a 502
// back to the client. Backup import is one of the most destructive operations
// in the app — a silent failure or partial import would wipe user data — so
// these tests guard the contract end-to-end:
//
//   T1  database content survives the NDJSON path identically
//   T2  asset bytes survive the NDJSON path identically
//   T3  cold-storage migration (runs in the silent post-upload phase) succeeds
//   T4  a malformed backup ends in an `error` event with prior data intact
//       (the worst case here is `done.ok=true` arriving on a botched import)
//   T5  `progress` events fire with monotonically increasing bytes
//   T6  heartbeats actually fire during processing (proves the keepalive
//       mechanism — without it the fix degrades to a silent 502 again)

type NdjsonEvent =
  | { type: 'progress'; bytes: number; totalBytes: number }
  | { type: 'heartbeat' }
  | { type: 'done'; ok: boolean; assetsRestored?: number; coldStorageFailed?: number }
  | { type: 'error'; message: string }

interface NdjsonImportResult {
  response: Response
  events: NdjsonEvent[]
  done?: Extract<NdjsonEvent, { type: 'done' }>
  errors: Array<Extract<NdjsonEvent, { type: 'error' }>>
  progresses: Array<Extract<NdjsonEvent, { type: 'progress' }>>
  heartbeats: Array<Extract<NdjsonEvent, { type: 'heartbeat' }>>
}

async function importViaNdjson(
  client: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  seed: Buffer,
): Promise<NdjsonImportResult> {
  const prepRes = await client.fetch('/api/backup/import/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: seed.byteLength }),
  })
  if (!prepRes.ok) throw new Error(`prepare failed: ${prepRes.status} ${await prepRes.text()}`)

  const response = await client.fetch('/api/backup/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-risu-backup',
      'accept': 'application/x-ndjson',
    },
    body: new Uint8Array(seed),
  })
  const text = await response.text()
  const events: NdjsonEvent[] = text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as NdjsonEvent)

  return {
    response,
    events,
    done: events.find((e): e is Extract<NdjsonEvent, { type: 'done' }> => e.type === 'done'),
    errors: events.filter((e): e is Extract<NdjsonEvent, { type: 'error' }> => e.type === 'error'),
    progresses: events.filter((e): e is Extract<NdjsonEvent, { type: 'progress' }> => e.type === 'progress'),
    heartbeats: events.filter((e): e is Extract<NdjsonEvent, { type: 'heartbeat' }> => e.type === 'heartbeat'),
  }
}

describe('ndjson streaming import', () => {
  // T1 — DB content must come through unchanged via the NDJSON path. A
  // regression that bypassed importBackupFromSource (or short-circuited it)
  // would be the worst-case silent corruption; we compare normalized output
  // to a baseline produced by the existing non-NDJSON path on a peer server.
  test('T1: round-trip database matches non-NDJSON path byte-for-byte (normalized)', async () => {
    const seed = createSeedBackup({ characterCount: 3, chatsPerCharacter: 2, messagesPerChat: 4 })

    const srvBaseline = await spawnServer()
    servers.push(srvBaseline)
    const clientBaseline = await createClient(srvBaseline.port, srvBaseline.password)
    await clientBaseline.importBackup(seed)
    const baselineExport = await clientBaseline.exportBackup()

    const srvNdjson = await spawnServer()
    servers.push(srvNdjson)
    const clientNdjson = await createClient(srvNdjson.port, srvNdjson.password)
    const ndjson = await importViaNdjson(clientNdjson, seed)
    expect(ndjson.response.ok).toBe(true)
    expect(ndjson.done?.ok).toBe(true)
    const ndjsonExport = await clientNdjson.exportBackup()

    const baseline = normalizeBackup(baselineExport)
    const fromNdjson = normalizeBackup(ndjsonExport)
    expect(fromNdjson.normalized.characterCount).toBe(baseline.normalized.characterCount)
    expect(fromNdjson.normalized.characters).toEqual(baseline.normalized.characters)
    expect(fromNdjson.normalized.personaCount).toBe(baseline.normalized.personaCount)
  })

  // T2 — asset bytes are written via a different code path than the DB
  // (kv writes vs sqlite restore). Fingerprint compare guards against any
  // off-by-one truncation or accidental skipping when streaming the body.
  test('T2: assets survive the NDJSON path with identical fingerprints', async () => {
    const seed = createSeedBackup({ characterCount: 2, includeAssets: true })
    const seedFingerprints = fingerprintAssets(seed)
    expect(seedFingerprints.length).toBe(2)

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const ndjson = await importViaNdjson(client, seed)
    expect(ndjson.done?.ok).toBe(true)
    expect(ndjson.errors).toEqual([])

    const exported = await client.exportBackup()
    expect(fingerprintAssets(exported)).toEqual(seedFingerprints)
  })

  // T3 — cold-storage migration runs *after* the body finishes streaming,
  // which is exactly the silent phase the heartbeat is meant to cover. We
  // assert both that the migration succeeded (coldStorageFailed=0) and that
  // the restored character is present in the re-export.
  test('T3: cold-storage character is restored when imported via NDJSON', async () => {
    const fullCharData = {
      character: {
        name: 'NdjsonColdChar',
        chaId: 'cold-char-ndjson-key',
        image: '', type: 'character',
        desc: 'Imported via NDJSON',
        firstMessage: 'Hello from NDJSON path!',
        chats: [{
          message: [{ role: 'char', data: 'Hello from NDJSON path!' }],
          note: '', name: 'Chat 1', localLore: [],
        }],
        chatPage: 0, firstMsgIndex: -1,
        notes: '', emotionImages: [], bias: [], globalLore: [],
        viewScreen: 'none', sdData: [], utilityBot: false,
        customscript: [], triggerscript: [],
        exampleMessage: '', creatorNotes: '', systemPrompt: '',
        postHistoryInstructions: '', alternateGreetings: [],
        tags: [], creator: '', characterVersion: '',
        personality: '', scenario: '', replaceGlobalNote: '',
        additionalText: '', chatFolders: [],
      },
    }

    const seed = createSeedBackup({
      characterCount: 1,
      coldStorageCharacters: [
        { name: 'NdjsonColdChar', coldKey: 'ndjson-key', fullData: fullCharData },
      ],
    })

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const ndjson = await importViaNdjson(client, seed)
    expect(ndjson.done?.ok).toBe(true)
    expect(ndjson.done?.coldStorageFailed ?? 0).toBe(0)

    const { normalized } = normalizeBackup(await client.exportBackup())
    const restored = normalized.characters.find(c => c.chaId === 'cold-char-ndjson-key')
    expect(restored).toBeDefined()
    expect(restored!.name).toBe('NdjsonColdChar')
    expect(restored!.firstMessages[0]).toBe('Hello from NDJSON path!')
  })

  // T4 — silent failure is the worst-case bug. If a malformed backup got
  // anywhere near a `done.ok=true` event the UI would tell the user that
  // their import succeeded while their existing data was actually wiped.
  // The NDJSON path must surface an `error` event AND leave prior data intact.
  test('T4: malformed backup emits error event, no done, prior data intact', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const goodSeed = createSeedBackup({ characterCount: 1 })
    await client.importBackup(goodSeed)
    const beforeExport = await client.exportBackup()
    const before = normalizeBackup(beforeExport)

    const badBackup = encodeBackup([
      { name: 'some-random-asset.png', data: Buffer.from('not-a-real-png') },
      { name: 'failed unsafe asset.png', data: Buffer.from('must roll back from KV') },
    ])

    const ndjson = await importViaNdjson(client, badBackup)
    expect(ndjson.errors.length).toBeGreaterThanOrEqual(1)
    expect(ndjson.done).toBeUndefined()

    const afterExport = await client.exportBackup()
    const after = normalizeBackup(afterExport)
    expect(after.normalized.characterCount).toBe(before.normalized.characterCount)
    expect(after.normalized.characters).toEqual(before.normalized.characters)
    await expectMissing(path.join(srv.cwd, 'save', 'assets', 'some-random-asset.png'))
    expect(readKvValue(srv.cwd, 'assets/failed unsafe asset.png')).toBeNull()
  })

  // T5 — progress events are the contract the UI relies on to drive its
  // upload progress bar. If a refactor accidentally drops the onProgress
  // callback or rewires it to fire only once, the UI silently regresses.
  test('T5: emits at least one progress event with monotonically increasing bytes', async () => {
    const seed = createSeedBackup({ characterCount: 5, chatsPerCharacter: 3, messagesPerChat: 6, includeAssets: true })

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const ndjson = await importViaNdjson(client, seed)
    expect(ndjson.done?.ok).toBe(true)
    expect(ndjson.progresses.length).toBeGreaterThanOrEqual(1)

    let last = -1
    for (const p of ndjson.progresses) {
      expect(p.bytes).toBeGreaterThanOrEqual(last)
      expect(p.totalBytes).toBe(seed.byteLength)
      last = p.bytes
    }
    expect(last).toBeLessThanOrEqual(seed.byteLength)
  })

  // T6 — this is *the* reason the patch exists. If a future change drops
  // the setInterval call, every data test above keeps passing (small fixtures
  // finish before one heartbeat tick) but the production 502 would come back.
  //
  // Two things have to line up to observe a heartbeat at all:
  //   1. The heartbeat interval has to be short. We pin it to the floor
  //      (100 ms) via env override.
  //   2. The server has to spend more than one interval on the request, AND
  //      yield to the event loop while doing so (setInterval can't fire while
  //      JS is in a sync block). With a single-chunk Uint8Array body the
  //      whole import collapses into one for-await tick. So we stream the
  //      body in pieces with deliberate 60 ms gaps to force several yields.
  test('T6: heartbeats fire during processing when interval is tight', async () => {
    const srv = await spawnServer({ env: { BACKUP_NDJSON_HEARTBEAT_MS: '100' } })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 2, includeAssets: true })

    const prepRes = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: seed.byteLength }),
    })
    expect(prepRes.ok).toBe(true)

    const chunkSize = Math.max(1, Math.ceil(seed.byteLength / 5))
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= seed.byteLength) { controller.close(); return }
        const end = Math.min(offset + chunkSize, seed.byteLength)
        const chunk = new Uint8Array(seed.subarray(offset, end))
        offset = end
        if (offset < seed.byteLength) await new Promise(r => setTimeout(r, 60))
        controller.enqueue(chunk)
      },
    })

    const response = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-risu-backup',
        'accept': 'application/x-ndjson',
        'content-length': String(seed.byteLength),
      },
      body: body as unknown as BodyInit,
      // Node's fetch requires this flag for streaming request bodies.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    const text = await response.text()
    const events: NdjsonEvent[] = text
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as NdjsonEvent)
    const done = events.find((e): e is Extract<NdjsonEvent, { type: 'done' }> => e.type === 'done')
    const heartbeats = events.filter(e => e.type === 'heartbeat')

    expect(done?.ok).toBe(true)
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
  })

  // Backwards-compat sanity: a client that doesn't advertise NDJSON must
  // still get the legacy JSON response. The non-NDJSON branch is what every
  // integration helper in this file already exercises, but an explicit
  // negative test makes the contract surface visible.
  test('legacy clients without Accept header receive JSON, not NDJSON', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 1 })

    const prepRes = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: seed.byteLength }),
    })
    expect(prepRes.ok).toBe(true)

    const impRes = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(seed),
    })
    expect(impRes.headers.get('content-type')).toContain('application/json')
    const body = await impRes.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// ─── Malformed import safety ────────────────────────────────────────────────

describe('malformed import safety', () => {
  test('import rejects backup missing database.risudat without wiping existing data', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Seed valid data first
    const preservedValue = Buffer.from('pre-import asset bytes')
    const preservedName = hashAssetName(preservedValue)
    const preservedUnsafeName = 'pre import unsafe.png'
    const preservedUnsafeValue = Buffer.from('pre-import unsafe bytes')
    const seed = Buffer.concat([
      createSeedBackup({ characterCount: 1 }),
      encodeBackup([
        { name: preservedName, data: preservedValue },
        { name: preservedUnsafeName, data: preservedUnsafeValue },
      ]),
    ])
    await client.importBackup(seed)
    const beforeExport = await client.exportBackup()
    const before = normalizeBackup(beforeExport)
    expect(await readFile(path.join(srv.cwd, 'save', 'assets', preservedName))).toEqual(preservedValue)
    expect(readKvValue(srv.cwd, `assets/${preservedUnsafeName}`)).toEqual(preservedUnsafeValue)

    // Try importing a backup with no database.risudat
    const badBackup = encodeBackup([
      { name: 'some-random-asset.png', data: Buffer.from('not-a-real-png') },
      { name: 'failed unsafe asset.png', data: Buffer.from('must roll back from KV') },
    ])

    // The server should reject this (importBackupFromSource validates database presence)
    const res = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(badBackup),
    })
    // Expect a non-2xx or an error in the JSON response
    const body = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
    const rejected = !res.ok || body.error || !body.ok
    expect(rejected).toBe(true)

    // Verify original data is still intact
    const afterExport = await client.exportBackup()
    const after = normalizeBackup(afterExport)
    expect(after.normalized.characterCount).toBe(before.normalized.characterCount)
    expect(after.normalized.characters).toEqual(before.normalized.characters)
    expect(await readFile(path.join(srv.cwd, 'save', 'assets', preservedName))).toEqual(preservedValue)
    expect(readKvValue(srv.cwd, `assets/${preservedUnsafeName}`)).toEqual(preservedUnsafeValue)
    await expectMissing(path.join(srv.cwd, 'save', 'assets', 'some-random-asset.png'))
    expect(readKvValue(srv.cwd, 'assets/failed unsafe asset.png')).toBeNull()
  })

  test('import rejects truncated backup', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Seed valid data
    const seed = createSeedBackup()
    await client.importBackup(seed)

    // Create a truncated backup (cut a valid backup in half)
    const validBackup = createSeedBackup({ characterCount: 2 })
    const truncated = validBackup.subarray(0, Math.floor(validBackup.length / 2))

    const res = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(truncated),
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const rejected = !res.ok || body.error || !body.ok
    expect(rejected).toBe(true)

    // Original data should survive
    const afterExport = await client.exportBackup()
    const after = normalizeBackup(afterExport)
    expect(after.normalized.characterCount).toBe(1)
  })
})
