/**
 * Chunking lifecycle integration tests.
 *
 * Boots a real server with a LOW chunk threshold (POCKETRISU_CHUNK_THRESHOLD)
 * so large chat rows and full snapshots chunk, then drives the full lifecycle:
 *   import (externalizes) → stats → export → re-import (round-trip) →
 *   snapshots/limits → optimize/gc, plus the save-folder import paths.
 *
 * The default compat fixtures use tiny DBs (< 16 MB) that never chunk, so this
 * is the only suite that exercises the chunked path through db.cjs + server.cjs
 * end-to-end — exactly the wiring the unit tests can't reach.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zipSync } from 'fflate'
import { Packr } from 'msgpackr'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'

function dbBlobFromExport(exported: Buffer): Buffer {
  const entry = decodeBackup(exported).find((e) => e.name === 'database.risudat')
  if (!entry) throw new Error('export has no database.risudat')
  return entry.data
}

// Chunk anything larger than 4 KB so a normal seed DB chunks.
const CHUNK_ENV = { POCKETRISU_CHUNK_THRESHOLD: '4096' }
const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary')

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map((s) => s.cleanup())) })

async function boot(extraEnv: Record<string, string> = {}): Promise<{ client: RisuClient; srv: ServerHandle }> {
  const srv = await spawnServer({ env: { ...CHUNK_ENV, ...extraEnv } })
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  return { client, srv }
}

// A .bin backup whose DB comfortably exceeds the 4 KB threshold and spans
// several CDC chunks (avg ~16 KB, max 64 KB).
function oversizedSeed(): Buffer {
  return createSeedBackup({ characterCount: 5, chatsPerCharacter: 2, messagesPerChat: 1000 })
}

// Raw database.risudat blob (~400 KB) — used by the save-folder import paths,
// which feed hex-named files rather than a .bin backup.
const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
// salt makes two blobs differ so a snapshot of one has chunks the other lacks.
function bigDbBlob(salt = ''): Buffer {
  const characters = Array.from({ length: 5 }, (_, ci) => ({
    name: `Char${ci}`, chaId: `c${ci}`, type: 'character', chatPage: 0, image: '', desc: 'x', firstMessage: 'hi',
    chats: [{
      id: `chat${ci}`, name: 'c', lastDate: 0, localLore: [], scriptstate: {}, note: '',
      message: Array.from({ length: 2000 }, (_, mi) => ({ role: mi % 2 ? 'char' : 'user', data: `msg ${mi} of char ${ci} ${salt} ${'x'.repeat(20)}` })),
    }],
  }))
  const database = { characters, apiType: 'openai', personas: [{ name: 'D', icon: '', personaPrompt: '' }], botPresets: [], botPresetsId: 0, selectedCharacter: 0 }
  return Buffer.concat([MAGIC_RAW, packr.encode(database)])
}
function hugeChatDbBlob(): Buffer {
  const database = {
    characters: [{
      name: 'Threshold', chaId: 'threshold-char', type: 'character', chatPage: 0,
      image: '', desc: '', firstMessage: 'hi',
      chats: [{
        id: 'threshold-chat', name: 'large', lastDate: 0, localLore: [], scriptstate: {}, note: '',
        message: [{ role: 'char', data: 'h'.repeat(17 * 1024 * 1024) }],
      }],
    }],
    apiType: 'openai', personas: [], botPresets: [], botPresetsId: 0, selectedCharacter: 0,
  }
  return Buffer.concat([MAGIC_RAW, packr.encode(database)])
}
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')
function saveFolderZip(blob: Buffer): Buffer {
  return Buffer.from(zipSync({ [DB_BLOB_HEX]: new Uint8Array(blob) }))
}
async function uploadZip(client: RisuClient, blob: Buffer): Promise<Response> {
  return client.fetch('/api/migrate/save-folder/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: new Uint8Array(saveFolderZip(blob)),
  })
}

async function getStats(client: RisuClient): Promise<any> {
  const res = await client.fetch('/api/db/stats')
  expect(res.status).toBe(200)
  return res.json()
}

function getStorageLayout(srv: ServerHandle): {
  liveChunked: boolean
  chatRows: number
  chunkedChatRows: number
  externalizationMarker: string | null
  safetyBackups: number
} {
  const db = new Database(path.join(srv.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const live = db.prepare("SELECT value FROM kv WHERE key = 'database/database.bin'").get() as { value: Buffer } | undefined
    const chats = db.prepare("SELECT value FROM kv WHERE key LIKE 'chats/%'").all() as Array<{ value: Buffer }>
    const marker = db.prepare("SELECT value FROM kv WHERE key = 'migration/chats-externalized'").get() as { value: Buffer } | undefined
    const backups = db.prepare("SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'migration-backup/pre-chat-externalization-%'").get() as { count: number }
    return {
      liveChunked: !!live && Buffer.from(live.value).equals(CHUNK_MARKER),
      chatRows: chats.length,
      chunkedChatRows: chats.filter(row => Buffer.from(row.value).equals(CHUNK_MARKER)).length,
      externalizationMarker: marker ? Buffer.from(marker.value).toString('utf8') : null,
      safetyBackups: backups.count,
    }
  } finally {
    db.close()
  }
}

describe('chunking lifecycle (real server, low threshold)', () => {
  test('character and module stats reuse the revision-bound decoded database', async () => {
    const { client } = await boot()
    const module = {
      id: 'stats-module',
      name: 'Stats module',
      description: 'module body',
      assets: [],
    }
    expect((await client.importBackup(createSeedBackup({
      databaseFields: { modules: [module] },
    }))).ok).toBe(true)

    const firstCharacters = await client.fetch('/api/db/stats/characters')
    expect(firstCharacters.status).toBe(200)
    const characters = await firstCharacters.json() as Record<string, any>
    expect(characters).toMatchObject({
      characters: [expect.objectContaining({
        chaId: 'test-char-0',
        name: 'TestCharacter0',
        image: '',
        trashed: false,
        cardBytes: expect.any(Number),
        imgBytes: 0,
        chatBytes: expect.any(Number),
        totalBytes: expect.any(Number),
      })],
      orphan: { count: 0, totalSize: 0 },
      chatBytesNote: 'JSON.stringify estimate; on-disk msgpack ~0.6×',
      etag: expect.any(String),
    })
    const secondCharacters = await client.fetch('/api/db/stats/characters')
    expect(secondCharacters.status).toBe(200)
    expect(secondCharacters.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')
    await expect(secondCharacters.json()).resolves.toEqual(characters)

    const firstModules = await client.fetch('/api/db/stats/modules')
    expect(firstModules.status).toBe(200)
    const modules = await firstModules.json() as Record<string, any>
    const bodyBytes = JSON.stringify({
      id: module.id,
      name: module.name,
      description: module.description,
    }).length
    expect(modules).toEqual({
      modules: [{
        id: module.id,
        name: module.name,
        bodyBytes,
        assetBytes: 0,
        totalBytes: bodyBytes,
      }],
      etag: expect.any(String),
    })
    const secondModules = await client.fetch('/api/db/stats/modules')
    expect(secondModules.status).toBe(200)
    expect(secondModules.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')
    await expect(secondModules.json()).resolves.toEqual(modules)
  })

  test('importing an oversized DB externalizes and chunks its large chat rows', async () => {
    const { client, srv } = await boot()
    const r = await client.importBackup(oversizedSeed())
    expect(r.ok).toBe(true)

    const s = await getStats(client)
    const layout = getStorageLayout(srv)
    expect(s.chunks.liveChunked).toBe(false)
    expect(layout.liveChunked).toBe(false)
    expect(layout.chatRows).toBe(10)
    expect(layout.chunkedChatRows).toBeGreaterThan(0)
    expect(s.prefixes['chats/'].count).toBe(10)
    expect(s.prefixes['chats/'].totalSize).toBeGreaterThan(10 * CHUNK_MARKER.length)
    expect(s.chunks.count).toBeGreaterThan(1)
    expect(s.chunks.bytes).toBeGreaterThan(0)
  })

  test('a verified size inventory is invalidated by chunk loss and falls back fail-closed', async () => {
    const { client, srv } = await boot()
    expect((await client.importBackup(oversizedSeed())).ok).toBe(true)

    const baseline = await getStats(client)
    expect(baseline.prefixes['chats/'].totalSize).toBeGreaterThan(0)

    const sqlitePath = path.join(srv.cwd, 'save', 'risuai.db')
    const db = new Database(sqlitePath)
    const target = db.prepare(`
      SELECT manifest.manifest_key AS key, manifest.hash AS hash
        FROM manifest_chunks manifest
        JOIN kv ON kv.key = manifest.manifest_key
       WHERE manifest.manifest_key LIKE 'chats/%'
       ORDER BY manifest.manifest_key, manifest.seq
       LIMIT 1
    `).get() as { key: string; hash: string } | undefined
    expect(target).toBeTruthy()
    db.prepare('DELETE FROM chunks WHERE hash = ?').run(target!.hash)
    const revision = db.prepare(`
      SELECT source_revision AS sourceRevision,
             verified_revision AS verifiedRevision
        FROM chunk_manifest_inventory_revision
       WHERE manifest_key = ?
    `).get(target!.key) as { sourceRevision: number; verifiedRevision: number | null }
    db.close()

    expect(revision.sourceRevision).toBeGreaterThan(0)
    expect(revision.verifiedRevision).toBeNull()
    const response = await client.fetch('/api/db/stats')
    expect(response.status).toBe(500)
  })

  test('publish-time content warmth is revision-bound and direct tampering fails closed', async () => {
    const { client, srv } = await boot()
    expect((await client.importBackup(oversizedSeed())).ok).toBe(true)

    const sqlitePath = path.join(srv.cwd, 'save', 'risuai.db')
    const db = new Database(sqlitePath)
    const target = db.prepare(`
      SELECT manifest.manifest_key AS key,
             manifest.hash AS hash,
             chunk.data AS data,
             revision.source_revision AS sourceRevision,
             revision.content_verified_revision AS contentVerifiedRevision
        FROM manifest_chunks manifest
        JOIN chunks chunk ON chunk.hash = manifest.hash
        JOIN chunk_manifest_inventory_revision revision
          ON revision.manifest_key = manifest.manifest_key
       WHERE manifest.manifest_key LIKE 'chats/%'
       ORDER BY manifest.manifest_key, manifest.seq
       LIMIT 1
    `).get() as {
      key: string
      hash: string
      data: Buffer
      sourceRevision: number
      contentVerifiedRevision: number
    } | undefined
    expect(target).toBeTruthy()
    expect(target!.contentVerifiedRevision).toBe(target!.sourceRevision)

    const warmRead = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from(target!.key, 'utf8').toString('hex') },
    })
    expect(warmRead.status).toBe(200)
    expect((await warmRead.arrayBuffer()).byteLength).toBeGreaterThan(4096)

    const changed = Buffer.from(target!.data)
    changed[0] ^= 0xff
    db.prepare('UPDATE chunks SET data = ? WHERE hash = ?').run(changed, target!.hash)
    const invalidated = db.prepare(`
      SELECT source_revision AS sourceRevision,
             content_verified_revision AS contentVerifiedRevision
        FROM chunk_manifest_inventory_revision WHERE manifest_key = ?
    `).get(target!.key) as { sourceRevision: number; contentVerifiedRevision: number | null }
    db.close()
    expect(invalidated.sourceRevision).toBeGreaterThan(target!.sourceRevision)
    expect(invalidated.contentVerifiedRevision).not.toBe(invalidated.sourceRevision)

    const corruptRead = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from(target!.key, 'utf8').toString('hex') },
    })
    expect(corruptRead.status).toBe(500)
  })

  test('externalized DB exports to standard full .bin and round-trips into a fresh server', async () => {
    const { client } = await boot()
    await client.importBackup(oversizedSeed())

    const exported = await client.exportBackup()
    expect(exported.byteLength).toBeGreaterThan(4096)

    const { client: client2, srv: srv2 } = await boot()
    const r2 = await client2.importBackup(exported)
    expect(r2.ok).toBe(true)

    const s2 = await getStats(client2)
    expect(s2.chunks.liveChunked).toBe(false)
    expect(getStorageLayout(srv2).chatRows).toBe(10)
    const charRes = await client2.fetch('/api/db/stats/characters')
    expect(charRes.status).toBe(200)
    const chars = await charRes.json()
    expect(chars.characters.length).toBeGreaterThanOrEqual(5)
  })

  test('a chunked snapshot reports a real footprint, not the 13-byte marker', async () => {
    // No backup cooldown so the 2nd import snapshots the 1st (chunked) DB.
    const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
    expect((await uploadZip(client, bigDbBlob('AAA'))).status).toBe(200) // v1 chunked
    expect((await uploadZip(client, bigDbBlob('BBB'))).status).toBe(200) // snapshots v1, then v2

    const snaps = await (await client.fetch('/api/db/snapshots')).json()
    // The vacuous-pass guard: there must actually be a snapshot to check.
    expect(snaps.snapshots.length).toBeGreaterThan(0)
    for (const sn of snaps.snapshots) {
      expect(sn.size).not.toBe(13) // 13 = CHUNK_MARKER length (the old bug)
    }
    // The chunked snapshot of v1 differs from live v2, so its footprint is real.
    const maxSize = Math.max(...snaps.snapshots.map((s: any) => s.size))
    expect(maxSize).toBeGreaterThan(1000)

    const lim = await (await client.fetch('/api/db/snapshots/limits')).json()
    expect(lim.currentBytes).toBeGreaterThan(1000)
  })

  test('optimize runs gc and reports chunksReclaimed', async () => {
    const { client } = await boot()
    await client.importBackup(oversizedSeed())

    const res = await client.fetch('/api/db/optimize', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.chunksReclaimed).toBe('number')
    expect(typeof body.orphanChatRowsDeleted).toBe('number')
    expect(typeof body.orphanChatRowsSkippedRecent).toBe('number')
  })

  test('optimize sweeps old orphan chat rows but preserves recent transient rows', async () => {
    const { client, srv } = await boot()
    const strippedDb = {
      characters: [{ chaId: 'gc-char', name: 'GC', chats: [] }],
      apiType: 'openai',
      personas: [],
      botPresets: [],
      botPresetsId: 0,
      selectedCharacter: 0,
    }
    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': DB_BLOB_HEX,
      },
      body: new Uint8Array(Buffer.concat([MAGIC_RAW, packr.encode(strippedDb)])),
    })
    expect(write.status).toBe(200)

    for (const chatId of ['old-orphan', 'recent-orphan']) {
      const chat = {
        id: chatId,
        name: chatId,
        message: [{ role: 'user', data: chatId }],
      }
      const post = await client.fetch('/api/chat-content/gc-char/0', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-chat-id': chatId,
        },
        body: new Uint8Array(Buffer.concat([MAGIC_RAW, packr.encode(chat)])),
      })
      expect(post.status).toBe(200)
    }

    const sqlitePath = path.join(srv.cwd, 'save', 'risuai.db')
    const db = new Database(sqlitePath)
    db.prepare("UPDATE kv SET updated_at = ? WHERE key = 'chats/gc-char/old-orphan'")
      .run(Date.now() - 2 * 60 * 60 * 1000)
    db.close()

    const optimize = await client.fetch('/api/db/optimize', { method: 'POST' })
    expect(optimize.status).toBe(200)
    const result = await optimize.json()
    expect(result.orphanChatRowsDeleted).toBe(1)
    expect(result.orphanChatRowsSkippedRecent).toBe(1)

    const verifyDb = new Database(sqlitePath, { readonly: true })
    const remaining = verifyDb.prepare("SELECT key FROM kv WHERE key LIKE 'chats/%' ORDER BY key")
      .all()
      .map((row: any) => row.key)
    verifyDb.close()
    expect(remaining).toEqual(['chats/gc-char/recent-orphan'])
  })

  // The two save-folder import paths were where the raw-bind regressions hid.
  test('save-folder ZIP upload externalizes and chunks chat rows (importHexEntries)', async () => {
    const { client, srv } = await boot()
    const res = await uploadZip(client, bigDbBlob())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const s = await getStats(client)
    expect(s.chunks.liveChunked).toBe(false)
    expect(getStorageLayout(srv).chunkedChatRows).toBeGreaterThan(0)
    expect(s.chunks.count).toBeGreaterThan(1)
  })

  test('save-folder ZIP activity stream publishes a durable committed outcome', async () => {
    const { client } = await boot({ BACKUP_NDJSON_HEARTBEAT_MS: '100' })
    const operationId = randomUUID()
    const response = await client.fetch('/api/migrate/save-folder/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/zip',
        'accept': 'application/x-ndjson',
        'x-risu-replacement-id': operationId,
      },
      body: new Uint8Array(saveFolderZip(bigDbBlob('activity-stream'))),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(events.some(event => event.type === 'heartbeat')).toBe(true)
    expect(events.some(event => event.type === 'progress')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      operationId,
      ok: true,
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })

    const statusResponse = await client.fetch(`/api/replacement-operations/${operationId}`)
    expect(statusResponse.status).toBe(200)
    await expect(statusResponse.json()).resolves.toMatchObject({
      operationId,
      kind: 'save-folder-zip',
      state: 'committed',
      result: { ok: true },
      error: null,
    })
  })

  test('save-folder directory import externalizes and chunks chat rows (importHexFilesFromDir)', async () => {
    const { client, srv } = await boot()
    const dir = path.join(srv.cwd, 'migrate-src')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, DB_BLOB_HEX), bigDbBlob())

    const res = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const s = await getStats(client)
    expect(s.chunks.liveChunked).toBe(false)
    expect(getStorageLayout(srv).chunkedChatRows).toBeGreaterThan(0)
    expect(s.chunks.count).toBeGreaterThan(1)
  })

  test('restoring a chunked snapshot brings its data back (recovery path)', async () => {
    const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
    await uploadZip(client, bigDbBlob('AAA')) // v1
    await uploadZip(client, bigDbBlob('BBB')) // snapshots v1 (chunked), live = v2

    // Sanity: live is currently v2, not v1.
    expect(dbBlobFromExport(await client.exportBackup()).includes(Buffer.from('BBB'))).toBe(true)

    const snaps = (await (await client.fetch('/api/db/snapshots')).json()).snapshots
    expect(snaps.length).toBeGreaterThan(0)
    const res = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: snaps[0].key }), // newest = the v1 snapshot
    })
    expect(res.status).toBe(200)

    // Live is now v1 again, externalized and valid.
    const restored = dbBlobFromExport(await client.exportBackup())
    expect(restored.includes(Buffer.from('AAA'))).toBe(true)
    expect((await getStats(client)).chunks.liveChunked).toBe(false)
  })

  test('snapshot commit remains queryable after acknowledgement loss and restart', async () => {
    const { client, srv } = await boot({
      POCKETRISU_BACKUP_INTERVAL_MS: '0',
      POCKETRISU_TEST_SNAPSHOT_RESTORE_FAILPOINT: 'response',
      BACKUP_NDJSON_HEARTBEAT_MS: '100',
    })
    await uploadZip(client, bigDbBlob('status-before'))
    await uploadZip(client, bigDbBlob('status-after'))
    const snapshots = (await (await client.fetch('/api/db/snapshots')).json()).snapshots
    expect(snapshots.length).toBeGreaterThan(0)

    const operationId = randomUUID()
    const response = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/x-ndjson',
        'x-risu-replacement-id': operationId,
      },
      body: JSON.stringify({ key: snapshots[0].key }),
    })
    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toThrow()

    const statusBeforeRestart = await client.fetch(`/api/replacement-operations/${operationId}`)
    await expect(statusBeforeRestart.json()).resolves.toMatchObject({
      operationId,
      kind: 'internal-snapshot',
      state: 'committed',
      result: { ok: true, key: snapshots[0].key },
      error: null,
    })

    await srv.restart({ POCKETRISU_TEST_SNAPSHOT_RESTORE_FAILPOINT: '' })
    const restarted = await createClient(srv.port, srv.password)
    const statusAfterRestart = await restarted.fetch(`/api/replacement-operations/${operationId}`)
    await expect(statusAfterRestart.json()).resolves.toMatchObject({
      operationId,
      kind: 'internal-snapshot',
      state: 'committed',
      result: { ok: true, key: snapshots[0].key },
    })
  })

  test('optimize reclaims orphan chunks left by re-imports', async () => {
    const { client } = await boot() // default cooldown → 2nd import takes no snapshot
    await uploadZip(client, bigDbBlob('AAA')) // v1 chunked
    await uploadZip(client, bigDbBlob('BBB')) // v2 chunked; v1's chunks now unreferenced

    const before = await getStats(client)
    expect(before.chunks.orphanBytes).toBeGreaterThan(0)

    const opt = await (await client.fetch('/api/db/optimize', { method: 'POST' })).json()
    expect(opt.ok).toBe(true)
    expect(opt.chunksReclaimed).toBeGreaterThan(0)

    const after = await getStats(client)
    expect(after.chunks.orphanBytes).toBeLessThan(before.chunks.orphanBytes)
  })

  test('pre-SQLite hex save folder migrates and externalizes chats (migrateFromSaveDir)', async () => {
    // Plant an old file-based save folder (hex-named files, no SQLite marker)
    // with an oversized database.bin before the server boots.
    const srv = await spawnServer({
      env: CHUNK_ENV,
      seedSave: async (saveDir) => {
        await writeFile(path.join(saveDir, DB_BLOB_HEX), bigDbBlob('HEX'))
      },
    })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Boot ran migrateFromSaveDir followed by chat externalization.
    const s = await getStats(client)
    const layout = getStorageLayout(srv)
    expect(s.chunks.liveChunked).toBe(false)
    expect(layout.chunkedChatRows).toBeGreaterThan(0)
    expect(layout.externalizationMarker).toBe('done')
    expect(layout.safetyBackups).toBe(1)
    expect(s.chunks.count).toBeGreaterThan(1)
    // And the migrated data is intact (exports the seeded content back out).
    expect(dbBlobFromExport(await client.exportBackup()).includes(Buffer.from('HEX'))).toBe(true)
  })

  test('downgrade escape: externalized rows export a standard blob a non-chunking server reads', async () => {
    const { client, srv } = await boot()
    await uploadZip(client, bigDbBlob('XYZ'))
    expect((await getStats(client)).chunks.liveChunked).toBe(false)
    expect(getStorageLayout(srv).chunkedChatRows).toBeGreaterThan(0)

    // The export is the full reassembled DB (not a 13-byte marker) — readable by
    // any version, including one with no chunking at all.
    const blob = dbBlobFromExport(await client.exportBackup())
    expect(blob.length).toBeGreaterThan(4096)
    expect(blob.includes(Buffer.from('XYZ'))).toBe(true)

    // The bounded server still accepts the portable blob through the ordinary
    // import path; chunking remains an internal layout detail.
    const exported = await client.exportBackup()
    const { client: oldish } = await boot({ POCKETRISU_CHUNK_THRESHOLD: '9999999999' })
    expect((await oldish.importBackup(exported)).ok).toBe(true)
    const s2 = await getStats(oldish)
    expect(s2.chunks.liveChunked).toBe(false)
  })

  test.each(['9999999999', 'Infinity', 'NaN', '0', '-1'])(
    'unsafe chunk threshold %s cannot create an oversized raw chat row',
    async (threshold) => {
      const { client, srv } = await boot({ POCKETRISU_CHUNK_THRESHOLD: threshold })
      expect((await uploadZip(client, hugeChatDbBlob())).status).toBe(200)
      const layout = getStorageLayout(srv)
      expect(layout.chatRows).toBe(1)
      expect(layout.chunkedChatRows).toBe(1)
    },
    30_000,
  )
})
