/**
 * A streamed import keeps one raw SQLite transaction open across decompression,
 * msgpack walking and directory publication. The server owns a single writable
 * better-sqlite3 connection, so any statement issued during that window joins the
 * import transaction — and would be discarded by its ROLLBACK.
 *
 * These tests drive a *late-failing* streamed import (a gzip whose trailing
 * checksum is corrupt, so it only throws after the whole payload has been read)
 * while a plugin write races it. The write must never report success and then
 * vanish: either it commits before the import opens its transaction, or it is
 * refused with a retryable status.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { gzipSync } from 'node:zlib'
import { Packr } from 'msgpackr'
import * as fflate from 'fflate'
import utilsPkg from '../../server/node/utils.cjs'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { createSeedBackup } from './helpers/seed.js'

const { magicCompressedHeader } = utilsPkg as any

const packr = new Packr({ useRecords: false })
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

const VICTIM_KEY = `pluginsave/${Buffer.from('import-barrier-victim', 'utf-8').toString('base64url')}.json`
const VICTIM_OWNER_KEY = `pluginsave-meta/${Buffer.from('import-barrier-victim', 'utf-8').toString('base64url')}.json`
const OLD_VALUE = Buffer.from('{"generation":"before-import"}')
const NEW_VALUE = Buffer.from('{"generation":"during-import"}')
const OLD_OWNER = Buffer.from('{"plugin":"Barrier Plugin","updatedAt":1}')

function hexPath(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
}

function writeKv(client: RisuClient, key: string, value: Buffer): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'file-path': hexPath(key) },
    body: new Uint8Array(value),
  })
}

async function readKv(client: RisuClient, key: string): Promise<Buffer | null> {
  const res = await client.fetch('/api/read', { headers: { 'file-path': hexPath(key) } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`read ${key} failed: ${res.status} ${await res.text()}`)
  const value = Buffer.from(await res.arrayBuffer())
  return value.byteLength === 0 ? null : value
}

/**
 * A supported (magic + gzip) MessagePack database whose gzip trailer is
 * corrupted. `inspectRisuSaveSource` accepts it and routes it to the streaming
 * ingest, but zlib only rejects it once the final checksum is verified — i.e.
 * after the import transaction has been open for the whole payload.
 */
function corruptTrailerDatabase(payloadBytes: number): Buffer {
  const filler = 'x'.repeat(payloadBytes)
  const database = {
    characters: [{
      name: 'Barrier Victim',
      chaId: 'barrier-char-0',
      type: 'character',
      chatPage: 0,
      firstMsgIndex: -1,
      chats: [{
        id: 'barrier-chat-0',
        name: 'Chat 0',
        message: [{ role: 'char', data: filler }],
        lastDate: 0,
        localLore: [],
        note: '',
      }],
      chatFolders: [],
    }],
  }
  const gzipped = gzipSync(packr.encode(database), { level: 1 })
  // Flip the last CRC32 byte. Everything up to the trailer inflates cleanly.
  gzipped[gzipped.length - 1] ^= 0xff
  return Buffer.concat([Buffer.from(magicCompressedHeader), gzipped])
}

async function seedVictim(port: number, password: string): Promise<RisuClient> {
  const client = await createClient(port, password)
  expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
  expect((await writeKv(client, VICTIM_KEY, OLD_VALUE)).status).toBe(200)
  expect((await writeKv(client, VICTIM_OWNER_KEY, OLD_OWNER)).status).toBe(200)
  expect(await readKv(client, VICTIM_KEY)).toEqual(OLD_VALUE)
  expect(await readKv(client, VICTIM_OWNER_KEY)).toEqual(OLD_OWNER)
  return client
}

/**
 * The invariant under test. `status` is what the concurrent write reported;
 * `stored` is what the key holds after the import rolled back.
 */
function expectNoLostAcknowledgedWrite(status: number, stored: Buffer | null): void {
  if (status === 200) {
    // Acknowledged, so it must have survived the rollback.
    expect(stored).toEqual(NEW_VALUE)
    return
  }
  expect(status).toBe(503)
  // Refused before mutating, so the pre-import value must still be intact.
  expect(stored).toEqual(OLD_VALUE)
}

describe('mutations racing a late-failing streamed import', () => {
  test('backup import: a plugin write during the upload window is never lost', async () => {
    const server = await spawnServer({ env: { RISU_STREAM_INGEST_MIN_BYTES: '1' } })
    servers.push(server)
    const client = await seedVictim(server.port, server.password)

    const backup = encodeBackup([
      { name: 'database.risudat', data: corruptTrailerDatabase(64 * 1024) },
    ])

    // The backup import opens its transaction *before* consuming the request
    // body, so trickling the upload holds that transaction open for as long as
    // this stream stays unfinished — a deterministic race window.
    let releaseUpload: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array(backup))
        await uploadGate
        controller.close()
      },
    })

    const prepare = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: backup.byteLength }),
    })
    expect(prepare.status).toBe(200)

    const importDone = client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body,
      // @ts-expect-error -- Node's fetch requires this for streaming bodies.
      duplex: 'half',
    })

    // Let the handler reach BEGIN and start draining the body.
    await new Promise(resolve => setTimeout(resolve, 500))
    const victimWrite = await writeKv(client, VICTIM_KEY, NEW_VALUE)
    const victimStatus = victimWrite.status
    await victimWrite.text()

    releaseUpload!()
    const importResponse = await importDone
    await importResponse.text()
    // The corrupt trailer must abort the import rather than commit partial state.
    expect(importResponse.ok).toBe(false)

    expectNoLostAcknowledgedWrite(victimStatus, await readKv(client, VICTIM_KEY))
    // The rolled-back import must not have replaced the seeded database either.
    const database = await readKv(client, 'database/database.bin')
    expect(database).toBeTruthy()
  }, 120_000)

  test('backup import: the barrier refuses writes rather than silently dropping them', async () => {
    const server = await spawnServer({ env: { RISU_STREAM_INGEST_MIN_BYTES: '1' } })
    servers.push(server)
    const client = await seedVictim(server.port, server.password)

    const backup = encodeBackup([
      { name: 'database.risudat', data: corruptTrailerDatabase(64 * 1024) },
    ])

    let releaseUpload: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array(backup))
        await uploadGate
        controller.close()
      },
    })

    expect((await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: backup.byteLength }),
    })).status).toBe(200)

    const importDone = client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body,
      // @ts-expect-error -- Node's fetch requires this for streaming bodies.
      duplex: 'half',
    })
    await new Promise(resolve => setTimeout(resolve, 500))

    const write = await writeKv(client, VICTIM_KEY, NEW_VALUE)
    const payload = await write.json() as Record<string, unknown>
    expect(write.status).toBe(503)
    expect(payload.code).toBe('IMPORT_IN_PROGRESS')
    expect(payload.retryable).toBe(true)
    expect(write.headers.get('retry-after')).toBeTruthy()

    const ownerWrite = await writeKv(client, VICTIM_OWNER_KEY, OLD_OWNER)
    expect(ownerWrite.status).toBe(503)
    await ownerWrite.text()
    const clear = await client.fetch('/api/plugin-storage/clear', { method: 'POST' })
    const clearPayload = await clear.json() as Record<string, unknown>
    expect(clear.status).toBe(503)
    expect(clearPayload).toMatchObject({
      code: 'IMPORT_IN_PROGRESS',
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
      retryable: true,
    })

    // Deletes and chat-row saves share the same gate.
    const remove = await client.fetch('/api/remove', { headers: { 'file-path': hexPath(VICTIM_KEY) } })
    expect(remove.status).toBe(503)
    await remove.text()

    const chatSave = await client.fetch('/api/chat-content/barrier-char-0/0', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chat-id': 'barrier-chat-0' },
      body: JSON.stringify({ id: 'barrier-chat-0', message: [] }),
    })
    expect(chatSave.status).toBe(503)
    await chatSave.text()

    releaseUpload!()
    const importResponse = await importDone
    await importResponse.text()
    expect(importResponse.ok).toBe(false)

    expect(await readKv(client, VICTIM_KEY)).toEqual(OLD_VALUE)
    expect(await readKv(client, VICTIM_OWNER_KEY)).toEqual(OLD_OWNER)

    // The barrier releases with the import: the retry the client was told to
    // make must now succeed.
    const retry = await writeKv(client, VICTIM_KEY, NEW_VALUE)
    expect(retry.status).toBe(200)
    await retry.text()
    expect(await readKv(client, VICTIM_KEY)).toEqual(NEW_VALUE)

    // The retry promised by the clear response runs after the barrier releases
    // and atomically removes both the value and owner namespaces.
    const clearRetry = await client.fetch('/api/plugin-storage/clear', { method: 'POST' })
    expect(clearRetry.status).toBe(200)
    expect(await clearRetry.json()).toMatchObject({
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })
    expect(await readKv(client, VICTIM_KEY)).toBeNull()
    expect(await readKv(client, VICTIM_OWNER_KEY)).toBeNull()
  }, 120_000)

  test('save-folder import: streamed ingest cannot roll back an acknowledged write', async () => {
    const server = await spawnServer({ env: { RISU_STREAM_INGEST_MIN_BYTES: '1' } })
    servers.push(server)
    const client = await seedVictim(server.port, server.password)

    // The save-folder path buffers its zip before BEGIN, so the race window is
    // the gunzip + walk of database/database.bin. A payload that inflates to
    // ~96 MiB keeps that window open for hundreds of milliseconds.
    const database = corruptTrailerDatabase(96 * 1024 * 1024)
    const zip = Buffer.from(fflate.zipSync({
      [hexPath('database/database.bin')]: new Uint8Array(database),
    }))

    const importDone = client.fetch('/api/migrate/save-folder/upload', {
      method: 'POST',
      // 'application/zip' (not octet-stream) so the global express.raw()
      // middleware leaves the body unbuffered for the streaming handler.
      headers: { 'content-type': 'application/zip' },
      body: new Uint8Array(zip),
    })

    // Hammer distinct keys for the whole import. Each key records its own
    // verdict, so every acknowledgement is audited individually rather than
    // depending on the race landing on one exact instant.
    const attempts: Array<{ key: string; value: Buffer; status: number }> = []
    let importSettled = false
    importDone.finally(() => { importSettled = true }).catch(() => {})
    for (let i = 0; !importSettled; i++) {
      const key = `pluginsave/${Buffer.from(`barrier-attempt-${i}`, 'utf-8').toString('base64url')}.json`
      const value = Buffer.from(`{"attempt":${i}}`)
      const res = await writeKv(client, key, value)
      await res.text()
      attempts.push({ key, value, status: res.status })
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const importResponse = await importDone
    await importResponse.text()
    expect(importResponse.ok).toBe(false)

    // Primary invariant: no acknowledged write may be missing after rollback.
    const lost: string[] = []
    for (const attempt of attempts) {
      expect([200, 503]).toContain(attempt.status)
      if (attempt.status !== 200) continue
      const stored = await readKv(client, attempt.key)
      if (stored === null || !stored.equals(attempt.value)) lost.push(attempt.key)
    }
    expect(lost).toEqual([])

    // The pre-import key must be intact either way, and the window must have
    // genuinely been exercised rather than missed.
    expect(await readKv(client, VICTIM_KEY)).toEqual(OLD_VALUE)
    expect(attempts.some(attempt => attempt.status === 503)).toBe(true)
  }, 180_000)
})
