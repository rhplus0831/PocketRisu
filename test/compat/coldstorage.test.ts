/**
 * Cold storage compatibility tests.
 *
 * Tests the one-time migration path: upstream backup with cold storage
 * characters → NodeOnly import → characters restored inline.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { gzipSync } from 'node:zlib'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { normalizeBackup } from './helpers/normalize.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

async function writeColdRow(client: RisuClient, key: string, coldData: unknown): Promise<Buffer> {
  const stored = gzipSync(Buffer.from(JSON.stringify(coldData), 'utf-8'))
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(`coldstorage/${key}`, 'utf-8').toString('hex'),
    },
    body: new Uint8Array(stored),
  })
  expect(response.status).toBe(200)
  return stored
}

async function fetchStats(client: RisuClient): Promise<{
  response: Response
  body: Record<string, any>
}> {
  const response = await client.fetch('/api/db/stats')
  expect(response.status).toBe(200)
  return { response, body: await response.json() as Record<string, any> }
}

describe('character cold storage migration', () => {

  test('restores cold storage character from upstream backup', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Build a backup with one normal char + one cold storage char
    const fullCharData = {
      character: {
        name: 'ColdChar',
        chaId: 'cold-char-cs-key-1',
        image: '',
        type: 'character',
        desc: 'A restored character',
        firstMessage: 'Hello from cold storage!',
        chats: [{
          message: [{ role: 'char', data: 'Hello from cold storage!' }],
          note: '', name: 'Chat 1', localLore: [],
        }],
        chatPage: 0,
        firstMsgIndex: -1,
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
        { name: 'ColdChar', coldKey: 'cs-key-1', fullData: fullCharData },
      ],
    })

    const result = await client.importBackup(seed)
    expect(result.ok).toBe(true)
    expect(result.coldStorageFailed ?? 0).toBe(0)

    // Export and verify the cold storage character was restored
    const exportBin = await client.exportBackup()
    const { normalized } = normalizeBackup(exportBin)

    const coldChar = normalized.characters.find(c => c.chaId === 'cold-char-cs-key-1')
    expect(coldChar).toBeDefined()
    expect(coldChar!.name).toBe('ColdChar')
    // Should have the restored chat, not the stub placeholder
    expect(coldChar!.messageCounts[0]).toBeGreaterThan(0)
    expect(coldChar!.firstMessages[0]).toBe('Hello from cold storage!')
  })

  test('promotes failed cold storage character to blank with recovery info', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Build a backup with a cold storage stub but NO corresponding KV entry
    const seed = createSeedBackup({
      characterCount: 1,
      coldStorageCharacters: [
        { name: 'BrokenChar', coldKey: 'missing-key', fullData: null },
      ],
    })

    const result = await client.importBackup(seed)
    expect(result.ok).toBe(true)
    expect(result.coldStorageFailed).toBe(1)

    // Export and verify the character was promoted to blank (not deleted)
    const exportBin = await client.exportBackup()
    const { raw } = normalizeBackup(exportBin)
    const chars = raw.characters as any[]

    const brokenChar = chars.find((c: any) => c.chaId === 'cold-char-missing-key')
    expect(brokenChar).toBeDefined()
    expect(brokenChar.name).toBe('BrokenChar')
    // coldstorage field should be gone
    expect(brokenChar.coldstorage).toBeUndefined()
    // desc should contain recovery key
    expect(brokenChar.desc).toContain('missing-key')
    expect(brokenChar.desc).toContain('Cold storage restore failed')
    // firstMsgIndex should be -1 (safe default)
    expect(brokenChar.firstMsgIndex).toBe(-1)
    // Should have valid structure (not crash-prone stub)
    expect(Array.isArray(brokenChar.globalLore)).toBe(true)
    expect(Array.isArray(brokenChar.bias)).toBe(true)
    expect(Array.isArray(brokenChar.emotionImages)).toBe(true)
  })

  test('cold storage round-trip: import → export preserves cold storage KV entries', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const fullCharData = {
      character: {
        name: 'RoundTripChar',
        chaId: 'cold-char-rt-key',
        image: '', type: 'character',
        desc: 'Round trip test',
        firstMessage: 'RT hello',
        chats: [{ message: [{ role: 'char', data: 'RT hello' }], note: '', name: 'Chat 1', localLore: [] }],
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
      characterCount: 0,
      coldStorageCharacters: [
        { name: 'RoundTripChar', coldKey: 'rt-key', fullData: fullCharData },
      ],
    })

    await client.importBackup(seed)

    // Server A export → Server B import → Server B export → compare
    const exportA = await client.exportBackup()

    const srvB = await spawnServer()
    servers.push(srvB)
    const clientB = await createClient(srvB.port, srvB.password)
    await clientB.importBackup(exportA)
    const exportB = await clientB.exportBackup()

    const normA = normalizeBackup(exportA)
    const normB = normalizeBackup(exportB)

    const charA = normA.normalized.characters.find(c => c.chaId === 'cold-char-rt-key')
    const charB = normB.normalized.characters.find(c => c.chaId === 'cold-char-rt-key')
    expect(charA).toBeDefined()
    expect(charB).toBeDefined()
    expect(charA!.name).toBe(charB!.name)
    expect(charA!.firstMessages).toEqual(charB!.firstMessages)
  })

  test('backup-size stats only reparse changed cold-storage rows', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
    const baseline = await fetchStats(client)
    const baselineEstimate = baseline.body.estimatedBackupSize as number
    expect(baseline.response.headers.get('x-pocketrisu-test-cold-rows-recomputed')).toBe('0')

    const alpha = { messages: ['alpha'] }
    const bravo = { messages: ['bravo'] }
    const beta = { character: { name: 'Cold beta', desc: 'memoized row' } }
    const alphaStored = await writeColdRow(client, 'alpha', alpha)
    const betaStored = await writeColdRow(client, 'beta', beta)

    const first = await fetchStats(client)
    const initialColdOutputSize = Buffer.byteLength(JSON.stringify(alpha))
      + Buffer.byteLength(JSON.stringify(beta))
    expect(first.response.headers.get('x-pocketrisu-test-cold-rows-recomputed')).toBe('2')
    expect(first.body.estimatedBackupSize).toBe(baselineEstimate + initialColdOutputSize)

    const second = await fetchStats(client)
    expect(second.response.headers.get('x-pocketrisu-test-cold-rows-recomputed')).toBe('0')
    expect(second.body.estimatedBackupSize).toBe(baselineEstimate + initialColdOutputSize)

    const bravoStored = await writeColdRow(client, 'alpha', bravo)
    expect(bravoStored.length).toBe(alphaStored.length)
    const sameSizeRewrite = await fetchStats(client)
    expect(sameSizeRewrite.response.headers.get('x-pocketrisu-test-cold-rows-recomputed')).toBe('1')
    expect(sameSizeRewrite.body.estimatedBackupSize).toBe(
      baselineEstimate
        + Buffer.byteLength(JSON.stringify(bravo))
        + Buffer.byteLength(JSON.stringify(beta)),
    )

    const expanded = { messages: ['expanded cold row '.repeat(20)] }
    await writeColdRow(client, 'alpha', expanded)
    const changedOutput = await fetchStats(client)
    expect(changedOutput.response.headers.get('x-pocketrisu-test-cold-rows-recomputed')).toBe('1')
    expect(changedOutput.body.estimatedBackupSize).toBe(
      baselineEstimate
        + Buffer.byteLength(JSON.stringify(expanded))
        + Buffer.byteLength(JSON.stringify(beta)),
    )
    expect(betaStored.length).toBeGreaterThan(0)
  })
})
