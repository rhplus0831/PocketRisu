import { afterAll, describe, expect, test } from 'vitest'
import { Packr } from 'msgpackr'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeRisuDat } from './helpers/normalize.js'

const servers: ServerHandle[] = []
const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })

afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

function hexPath(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
}

function encodeRisuDat(value: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(value))])
}

async function readDatabase(client: RisuClient): Promise<Record<string, any>> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': hexPath('database/database.bin') },
  })
  expect(response.status).toBe(200)
  return decodeRisuDat(Buffer.from(await response.arrayBuffer())) as Record<string, any>
}

async function writeDatabase(client: RisuClient, database: Record<string, any>): Promise<void> {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': hexPath('database/database.bin'),
    },
    body: new Uint8Array(encodeRisuDat(database)),
  })
  expect(response.status).toBe(200)
  await response.text()
}

async function writeInlay(client: RisuClient, id: string): Promise<void> {
  const payload = Buffer.from(JSON.stringify({
    data: 'data:image/png;base64,iVBORw0KGgo=',
    ext: 'png',
    name: `${id}.png`,
    type: 'image',
    width: 1,
    height: 1,
  }))
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': hexPath(`inlay/${id}`),
    },
    body: new Uint8Array(payload),
  })
  expect(response.status).toBe(200)
  await response.text()
}

async function inlayExists(client: RisuClient, id: string): Promise<boolean> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': hexPath(`inlay/${id}`) },
  })
  expect(response.status).toBe(200)
  return (await response.arrayBuffer()).byteLength > 0
}

async function expectDeletionBlocked(client: RisuClient, id: string): Promise<void> {
  const response = await client.fetch('/api/inlays/delete-unreferenced', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [id] }),
  })
  expect(response.status).toBe(500)
  expect(await inlayExists(client, id)).toBe(true)
}

async function saveChat(client: RisuClient, message: Record<string, unknown>): Promise<void> {
  const response = await client.fetch('/api/chat-content/inlay-char/0', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chat-id': 'inlay-chat',
    },
    body: JSON.stringify({
      id: 'inlay-chat',
      name: 'Inlay chat',
      message: [message],
      note: '',
      localLore: [],
    }),
  })
  expect(response.status).toBe(200)
  await response.text()
}

describe('authoritative inlay reference guard', () => {
  test('scans unopened chat rows and revalidates references inside guarded deletion', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const imported = await client.importBackup(createSeedBackup({
      databaseFields: {
        characters: [{
          name: 'Inlay Character',
          chaId: 'inlay-char',
          type: 'character',
          chatPage: 0,
          image: '',
          chats: [{
            id: 'inlay-chat',
            name: 'Inlay chat',
            message: [{
              role: 'char',
              data: 'kept {{inlay::stored-reference}}',
              swipes: ['kept {{inlayed::stored-swipe}}'],
            }],
            note: '',
            localLore: [],
          }],
        }],
      },
    }))
    expect(imported.ok).toBe(true)

    for (const id of ['stored-reference', 'stored-swipe', 'race-reference', 'client-only', 'orphan']) {
      await writeInlay(client, id)
    }

    // No chat-content read has occurred: this is the server row a fresh client
    // would still represent as an empty placeholder.
    const scanResponse = await client.fetch('/api/inlays/references')
    expect(scanResponse.status).toBe(200)
    const scan = await scanResponse.json() as {
      totalMessages: number
      refCounts: Record<string, number>
    }
    expect(scan.totalMessages).toBe(1)
    expect(scan.refCounts).toMatchObject({
      'stored-reference': 1,
      'stored-swipe': 1,
    })
    expect(scan.refCounts['race-reference']).toBeUndefined()

    // Add a reference after the gallery-style scan. The delete endpoint must
    // rescan while it owns the storage queue rather than trust the old result.
    await saveChat(client, {
      role: 'char',
      data: '{{inlay::stored-reference}} {{inlay::race-reference}}',
      swipes: ['{{inlayed::stored-swipe}}'],
    })

    const deletionResponse = await client.fetch('/api/inlays/delete-unreferenced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ids: ['stored-reference', 'stored-swipe', 'race-reference', 'client-only', 'orphan'],
        clientProtectedIds: ['client-only'],
      }),
    })
    expect(deletionResponse.status).toBe(200)
    const deletion = await deletionResponse.json() as {
      removedIds: string[]
      referencedIds: string[]
      commitOutcome: string
      commitOutcomeUnknown: boolean
    }
    expect(deletion.removedIds).toEqual(['orphan'])
    expect(deletion.referencedIds).toEqual([
      'stored-reference',
      'stored-swipe',
      'race-reference',
      'client-only',
    ])
    expect(deletion.commitOutcome).toBe('committed')
    expect(deletion.commitOutcomeUnknown).toBe(false)

    expect(await inlayExists(client, 'orphan')).toBe(false)
    for (const id of deletion.referencedIds) {
      expect(await inlayExists(client, id)).toBe(true)
    }

    // Compatibility callers of generic storage removal are guarded too.
    const legacyDelete = await client.fetch('/api/remove', {
      headers: { 'file-path': hexPath('inlay/stored-reference') },
    })
    expect(legacyDelete.status).toBe(409)
    const legacyError = await legacyDelete.json() as Record<string, unknown>
    expect(legacyError.code).toBe('INLAY_REFERENCED')
    expect(legacyError.commitOutcome).toBe('not-committed')
    expect(await inlayExists(client, 'stored-reference')).toBe(true)

    await saveChat(client, { role: 'char', data: 'all references removed', swipes: [] })
    const finalDelete = await client.fetch('/api/inlays/delete-unreferenced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ids: ['stored-reference', 'stored-swipe', 'race-reference', 'client-only'],
      }),
    })
    expect(finalDelete.status).toBe(200)
    const finalResult = await finalDelete.json() as { removedIds: string[], referencedIds: string[] }
    expect(finalResult.removedIds).toEqual([
      'race-reference',
      'client-only',
    ])
    // The first overwrite captured a retained pre-image. References that were
    // removed from the live row remain protected while that version exists.
    expect(finalResult.referencedIds).toEqual(['stored-reference', 'stored-swipe'])
    expect(await inlayExists(client, 'stored-reference')).toBe(true)
    expect(await inlayExists(client, 'stored-swipe')).toBe(true)
  }, 60_000)

  test('retained delete-chat history keeps inlays readable through restore', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const imported = await client.importBackup(createSeedBackup({
      databaseFields: {
        characters: [{
          name: 'History Inlay Character',
          chaId: 'history-inlay-char',
          type: 'character',
          chatPage: 0,
          image: '',
          chats: [{
            id: 'history-inlay-chat',
            name: 'History inlay chat',
            message: [{
              role: 'char',
              data: 'retained {{inlay::history-only}}',
              swipes: ['retained {{inlayeddata::history-swipe}}'],
            }],
            note: '',
            localLore: [],
          }],
        }],
      },
    }))
    expect(imported.ok).toBe(true)

    for (const id of ['history-only', 'history-swipe', 'true-orphan']) {
      await writeInlay(client, id)
    }

    const databaseWithoutChat = await readDatabase(client)
    expect(databaseWithoutChat.characters[0].chats).toHaveLength(1)
    databaseWithoutChat.characters[0].chats = []
    await writeDatabase(client, databaseWithoutChat)

    const historyResponse = await client.fetch(
      '/api/chat-backups/history-inlay-char/history-inlay-chat',
    )
    expect(historyResponse.status).toBe(200)
    const history = await historyResponse.json() as {
      versions: Array<{ versionId: string; reason: string }>
    }
    expect(history.versions).toHaveLength(1)
    expect(history.versions[0].reason).toBe('delete-chat')

    const scanResponse = await client.fetch('/api/inlays/references')
    expect(scanResponse.status).toBe(200)
    const scan = await scanResponse.json() as {
      totalHistoryVersions: number
      refCounts: Record<string, number>
    }
    expect(scan.totalHistoryVersions).toBe(1)
    expect(scan.refCounts).toMatchObject({
      'history-only': 1,
      'history-swipe': 1,
    })

    const deletionResponse = await client.fetch('/api/inlays/delete-unreferenced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['history-only', 'history-swipe', 'true-orphan'] }),
    })
    expect(deletionResponse.status).toBe(200)
    await expect(deletionResponse.json()).resolves.toMatchObject({
      removedIds: ['true-orphan'],
      referencedIds: ['history-only', 'history-swipe'],
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })
    expect(await inlayExists(client, 'true-orphan')).toBe(false)
    expect(await inlayExists(client, 'history-only')).toBe(true)
    expect(await inlayExists(client, 'history-swipe')).toBe(true)

    const versionResponse = await client.fetch(
      `/api/chat-backups/history-inlay-char/history-inlay-chat/${history.versions[0].versionId}`,
    )
    expect(versionResponse.status).toBe(200)
    const versionBytes = Buffer.from(await versionResponse.arrayBuffer())
    const restoredChat = decodeRisuDat(versionBytes) as Record<string, any>
    expect(restoredChat.message[0]).toMatchObject({
      data: 'retained {{inlay::history-only}}',
      swipes: ['retained {{inlayeddata::history-swipe}}'],
    })

    const restoreRow = await client.fetch('/api/chat-content/history-inlay-char/0', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-chat-id': 'history-inlay-chat',
      },
      body: new Uint8Array(versionBytes),
    })
    expect(restoreRow.status).toBe(200)
    databaseWithoutChat.characters[0].chats.push({
      id: 'history-inlay-chat',
      name: 'History inlay chat',
      _stub: true,
    })
    await writeDatabase(client, databaseWithoutChat)

    const sessionResponse = await client.fetch('/api/session', { method: 'POST' })
    expect(sessionResponse.status).toBe(200)
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeTruthy()
    const renderedMedia = await client.fetch(`/api/asset/${hexPath('inlay/history-only')}`, {
      headers: { cookie: cookie! },
    })
    expect(renderedMedia.status).toBe(200)
    expect(renderedMedia.headers.get('content-type')).toContain('image/png')
    expect(Buffer.from(await renderedMedia.arrayBuffer())).toEqual(
      Buffer.from('iVBORw0KGgo=', 'base64'),
    )
  }, 60_000)

  test('an unreadable retained version fails deletion closed', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    await writeInlay(client, 'protected-by-unreadable-history')

    const chatDir = path.join(
      server.cwd,
      'save',
      'chat-backups',
      'unreadable-char',
      'unreadable-chat',
    )
    await mkdir(chatDir, { recursive: true })
    await writeFile(
      path.join(chatDir, 'v-53000-0-corrupt.bin'),
      Buffer.from('not a decodable chat row'),
    )

    const deletionResponse = await client.fetch('/api/inlays/delete-unreferenced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['protected-by-unreadable-history'] }),
    })
    expect(deletionResponse.status).toBe(500)
    expect(await inlayExists(client, 'protected-by-unreadable-history')).toBe(true)
  }, 60_000)

  test('strict history inventory blocks deletion for unreadable directories and malformed metadata', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const inlayId = 'protected-by-strict-history-inventory'
    await writeInlay(client, inlayId)
    const historyRoot = path.join(server.cwd, 'save', 'chat-backups')

    const unreadableDir = path.join(historyRoot, 'unreadable-dir-char', 'unreadable-dir-chat')
    await mkdir(unreadableDir, { recursive: true })
    await writeFile(
      path.join(unreadableDir, 'v-54000-0-readable.bin'),
      encodeRisuDat({
        id: 'unreadable-dir-chat',
        message: [{ role: 'char', data: 'no inlay token required' }],
      }),
    )
    await chmod(unreadableDir, 0o000)
    try {
      await expectDeletionBlocked(client, inlayId)
    } finally {
      await chmod(unreadableDir, 0o700)
      await rm(path.join(historyRoot, 'unreadable-dir-char'), { recursive: true, force: true })
    }

    const frameDir = path.join(historyRoot, 'malformed-frame-char', 'malformed-frame-chat')
    await mkdir(frameDir, { recursive: true })
    await writeFile(path.join(frameDir, 'v-54001-0-malformed.frame'), 'not a frame')
    await expectDeletionBlocked(client, inlayId)
    await rm(path.join(historyRoot, 'malformed-frame-char'), { recursive: true, force: true })

    const bundleDir = path.join(historyRoot, 'malformed-bundle-char', 'malformed-bundle-chat')
    await mkdir(bundleDir, { recursive: true })
    await writeFile(path.join(bundleDir, 'archive-54002-54002.bundle'), 'not a bundle')
    await writeFile(
      path.join(bundleDir, 'archive-54002-54002.meta.json'),
      '{"format":"pocketrisu-chat-backup-bundle-v1","entries":',
    )
    await expectDeletionBlocked(client, inlayId)
    await rm(path.join(historyRoot, 'malformed-bundle-char'), { recursive: true, force: true })

    const finalDelete = await client.fetch('/api/inlays/delete-unreferenced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [inlayId] }),
    })
    expect(finalDelete.status).toBe(200)
    await expect(finalDelete.json()).resolves.toMatchObject({
      removedIds: [inlayId],
      referencedIds: [],
    })
    expect(await inlayExists(client, inlayId)).toBe(false)
  }, 60_000)

  test('deletion fails closed when a version disappears after strict inventory', async () => {
    const gateName = 'reachability-race-gate'
    const server = await spawnServer({
      env: { POCKETRISU_TEST_CHAT_BACKUP_REACHABILITY_GATE_DIR: gateName },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const inlayId = 'protected-by-inventory-read-race'
    await writeInlay(client, inlayId)

    const versionDir = path.join(
      server.cwd,
      'save',
      'chat-backups',
      'inventory-race-char',
      'inventory-race-chat',
    )
    const versionPath = path.join(versionDir, 'v-54003-0-disappears.bin')
    await mkdir(versionDir, { recursive: true })
    await writeFile(versionPath, encodeRisuDat({
      id: 'inventory-race-chat',
      message: [{ role: 'char', data: 'inventoried version' }],
    }))
    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), 'hold')

    const deletionPromise = client.fetch('/api/inlays/delete-unreferenced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [inlayId] }),
    })
    await expect.poll(() => existsSync(path.join(gateDir, 'entered')), {
      timeout: 10_000,
    }).toBe(true)
    await unlink(versionPath)
    await writeFile(path.join(gateDir, 'release'), 'release')
    const deletionResponse = await deletionPromise
    expect(deletionResponse.status).toBe(500)
    expect(await inlayExists(client, inlayId)).toBe(true)
  }, 60_000)

  test('an inaccessible protected conflict container blocks deletion of its history-only inlay', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const inlayId = 'protected-conflict-history-only'
    await writeInlay(client, inlayId)

    const conflictRoot = path.join(server.cwd, 'save', 'chat-backups', '%2Eroot-history')
    const protectedDir = path.join(
      conflictRoot,
      'protected-only',
      'conflict-char',
      'conflict-chat',
    )
    await mkdir(protectedDir, { recursive: true })
    await writeFile(
      path.join(protectedDir, 'v-55000-0-protected.bin'),
      encodeRisuDat({
        id: 'conflict-chat',
        message: [{ role: 'char', data: `only {{inlay::${inlayId}}}` }],
      }),
    )

    const readableScan = await client.fetch('/api/inlays/references')
    expect(readableScan.status).toBe(200)
    await expect(readableScan.json()).resolves.toMatchObject({
      refCounts: { [inlayId]: 1 },
    })

    await chmod(conflictRoot, 0o000)
    try {
      await expectDeletionBlocked(client, inlayId)
    } finally {
      await chmod(conflictRoot, 0o700)
    }

    const guardedDelete = await client.fetch('/api/inlays/delete-unreferenced', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [inlayId] }),
    })
    expect(guardedDelete.status).toBe(200)
    await expect(guardedDelete.json()).resolves.toMatchObject({
      removedIds: [],
      referencedIds: [inlayId],
    })
    expect(await inlayExists(client, inlayId)).toBe(true)
  }, 60_000)
})
