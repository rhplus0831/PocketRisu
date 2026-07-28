import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map((server) => server.cleanup()))
})

function hexPath(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
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
      'stored-reference',
      'stored-swipe',
      'race-reference',
      'client-only',
    ])
    expect(finalResult.referencedIds).toEqual([])
  }, 60_000)
})
