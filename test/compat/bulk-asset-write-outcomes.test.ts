import { afterAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

type BulkEntry = { key: string; value: Buffer }
type BulkOutcome = {
  index: number
  key: string
  status: 'committed' | 'not-committed' | 'unknown'
  changed?: boolean
  reconciled?: boolean
  retryable: boolean
  code?: string
}

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function keyHeader(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
}

async function writeOne(client: RisuClient, entry: BulkEntry): Promise<void> {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': keyHeader(entry.key),
    },
    body: new Uint8Array(entry.value),
  })
  expect(response.status).toBe(200)
}

async function readOne(client: RisuClient, key: string): Promise<Buffer> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': keyHeader(key) },
  })
  expect(response.status).toBe(200)
  return Buffer.from(await response.arrayBuffer())
}

async function bulkWrite(
  client: RisuClient,
  entries: BulkEntry[],
): Promise<{ body: Record<string, unknown>; results: BulkOutcome[] }> {
  const response = await bulkWriteResponse(client, entries)
  expect(response.status).toBe(200)
  const body = await response.json() as Record<string, unknown>
  expect(body).not.toHaveProperty('success')
  expect(body).not.toHaveProperty('count')
  expect(body.results).toBeInstanceOf(Array)
  return { body, results: body.results as BulkOutcome[] }
}

async function bulkWriteResponse(client: RisuClient, entries: BulkEntry[]): Promise<Response> {
  return await client.fetch('/api/assets/bulk-write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entries.map(entry => ({
      key: entry.key,
      value: entry.value.toString('base64'),
    }))),
  })
}

const oldEntries: BulkEntry[] = [
  { key: 'assets/bulk-first.bin', value: Buffer.from('old first asset') },
  { key: 'assets/bulk metadata.bin', value: Buffer.from('old sqlite metadata') },
  { key: 'assets/bulk-last.bin', value: Buffer.from('old last asset') },
]

const newEntries: BulkEntry[] = [
  { key: oldEntries[0].key, value: Buffer.from('new first asset') },
  { key: oldEntries[1].key, value: Buffer.from('new sqlite metadata') },
  { key: oldEntries[2].key, value: Buffer.from('new last asset') },
]

async function bootAtBoundary(failpoint: string): Promise<{
  server: ServerHandle
  client: RisuClient
}> {
  const server = await spawnServer({
    env: { POCKETRISU_TEST_BULK_WRITE_FAILPOINT: failpoint },
  })
  servers.push(server)
  const client = await createClient(server.port, server.password)
  for (const entry of oldEntries) await writeOne(client, entry)
  return { server, client }
}

async function restartWithoutFailpoint(server: ServerHandle): Promise<RisuClient> {
  await server.restart({ POCKETRISU_TEST_BULK_WRITE_FAILPOINT: '' })
  return await createClient(server.port, server.password)
}

async function expectValues(client: RisuClient, entries: BulkEntry[]): Promise<void> {
  for (const entry of entries) {
    expect(await readOne(client, entry.key)).toEqual(entry.value)
  }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await readFile(filePath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

describe('bulk asset per-entry durable outcomes', () => {
  test('rejects duplicate ordinary keys before a preceding entry can mutate', async () => {
    const { client } = await bootAtBoundary('')
    const duplicateKey = oldEntries[2].key

    const response = await bulkWriteResponse(client, [
      newEntries[0],
      { key: duplicateKey, value: Buffer.from('first duplicate value') },
      { key: duplicateKey, value: Buffer.from('conflicting duplicate value') },
    ])

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'DUPLICATE_BULK_WRITE_KEY',
      keys: [duplicateKey],
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    await expectValues(client, oldEntries)
  })

  test('rejects malformed reserved plugin rows before a preceding entry can mutate', async () => {
    const { client } = await bootAtBoundary('')

    const response = await bulkWriteResponse(client, [
      newEntries[0],
      {
        key: 'pluginsave/decoded-private-key',
        value: Buffer.from(JSON.stringify('forged')),
      },
    ])

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'INVALID_PLUGIN_STORAGE_ROW',
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    await expectValues(client, oldEntries)
  })

  test('revalidates a legacy hash exemption after entering the storage queue', async () => {
    const canonicalValue = Buffer.from('queued canonical identity')
    const name = `${createHash('sha256').update(canonicalValue).digest('hex')}.png`
    const key = `assets/${name}`
    const oldLegacyValue = Buffer.from('queued historical mismatch')
    const requestedMismatch = Buffer.from('queued replacement mismatch')
    const gateName = 'bulk-write-validation-gate'
    const markerRelativePath = path.join('assets', '.legacy-hash-assets', name)
    const server = await spawnServer({
      env: { POCKETRISU_TEST_BULK_WRITE_GATE_DIR: gateName },
      seedSave: async saveDir => {
        await mkdir(path.join(saveDir, 'assets', '.legacy-hash-assets'), { recursive: true })
        await writeFile(path.join(saveDir, 'assets', name), oldLegacyValue)
        await writeFile(
          path.join(saveDir, markerRelativePath),
          'legacy-hash-asset-v1\n',
        )
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    await writeOne(client, oldEntries[0])
    const gateDir = path.join(server.cwd, gateName)
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), 'hold')

    const pending = bulkWriteResponse(client, [
      newEntries[0],
      { key, value: requestedMismatch },
    ])
    await waitForFile(path.join(gateDir, 'entered'))
    await rm(path.join(server.cwd, 'save', markerRelativePath))
    await writeFile(path.join(gateDir, 'release'), 'release')
    const response = await pending

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'ASSET_HASH_STATE_CONFLICT',
      keys: [key],
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(await readOne(client, oldEntries[0].key)).toEqual(oldEntries[0].value)
    expect(await readOne(client, key)).toEqual(oldLegacyValue)
  })

  test('faulting every asset rename before publication reports only those entries not committed', async () => {
    const { server, client } = await bootAtBoundary('before-asset-publish:*')

    const { results } = await bulkWrite(client, newEntries)

    expect(results).toEqual([
      {
        index: 0,
        key: newEntries[0].key,
        status: 'not-committed',
        reconciled: true,
        retryable: true,
        code: 'BULK_ENTRY_WRITE_FAILED',
      },
      {
        index: 1,
        key: newEntries[1].key,
        status: 'committed',
        changed: true,
        retryable: false,
      },
      {
        index: 2,
        key: newEntries[2].key,
        status: 'not-committed',
        reconciled: true,
        retryable: true,
        code: 'BULK_ENTRY_WRITE_FAILED',
      },
    ])

    const restarted = await restartWithoutFailpoint(server)
    await expectValues(restarted, [oldEntries[0], newEntries[1], oldEntries[2]])

    const retryEntries = [newEntries[0], newEntries[2]]
    const retry = await bulkWrite(restarted, retryEntries)
    expect(retry.results.map(result => result.status)).toEqual(['committed', 'committed'])
    await expectValues(restarted, newEntries)
  })

  test('faulting after every durable asset rename reports the committed files exactly', async () => {
    const { server, client } = await bootAtBoundary('after-asset-publish:*')

    const { results } = await bulkWrite(client, newEntries)

    expect(results.map(result => ({
      key: result.key,
      status: result.status,
      reconciled: result.reconciled,
    }))).toEqual([
      { key: newEntries[0].key, status: 'committed', reconciled: true },
      { key: newEntries[1].key, status: 'committed', reconciled: undefined },
      { key: newEntries[2].key, status: 'committed', reconciled: true },
    ])

    const restarted = await restartWithoutFailpoint(server)
    await expectValues(restarted, newEntries)
  })

  test('a pre-COMMIT fault distinguishes published files from rolled-back SQLite entries', async () => {
    const { server, client } = await bootAtBoundary('before-sqlite-commit:*')

    const { results } = await bulkWrite(client, newEntries)

    expect(results.map(result => ({
      key: result.key,
      status: result.status,
      code: result.code,
    }))).toEqual([
      { key: newEntries[0].key, status: 'committed', code: undefined },
      {
        key: newEntries[1].key,
        status: 'not-committed',
        code: 'BULK_ENTRY_WRITE_FAILED',
      },
      { key: newEntries[2].key, status: 'committed', code: undefined },
    ])

    const restarted = await restartWithoutFailpoint(server)
    await expectValues(restarted, [newEntries[0], oldEntries[1], newEntries[2]])

    const retry = await bulkWrite(restarted, [newEntries[1]])
    expect(retry.results).toEqual([{
      index: 0,
      key: newEntries[1].key,
      status: 'committed',
      changed: true,
      retryable: false,
    }])
    await expectValues(restarted, newEntries)
  })

  test('a post-COMMIT fault reports every entry committed and survives restart', async () => {
    const { server, client } = await bootAtBoundary('after-sqlite-commit:*')

    const { results } = await bulkWrite(client, newEntries)

    expect(results.map(result => ({
      key: result.key,
      status: result.status,
      reconciled: result.reconciled,
    }))).toEqual(newEntries.map(entry => ({
      key: entry.key,
      status: 'committed',
      reconciled: true,
    })))

    const restarted = await restartWithoutFailpoint(server)
    await expectValues(restarted, newEntries)
  })

  test('a failed reconciliation read reports unknown instead of guessing from a prefix', async () => {
    const { server, client } = await bootAtBoundary(
      'before-asset-publish:0,reconciliation-read:0',
    )

    const { results } = await bulkWrite(client, newEntries)

    expect(results[0]).toEqual({
      index: 0,
      key: newEntries[0].key,
      status: 'unknown',
      reconciled: false,
      retryable: false,
      code: 'BULK_ENTRY_OUTCOME_UNKNOWN',
    })
    expect(results.slice(1).map(result => result.status)).toEqual(['committed', 'committed'])

    const restarted = await restartWithoutFailpoint(server)
    await expectValues(restarted, [oldEntries[0], newEntries[1], newEntries[2]])
  })

  test.each([
    ['before-legacy-hash-clear', 'not-committed'],
    ['after-legacy-hash-clear', 'committed'],
  ] as const)(
    'tracks the canonical legacy-marker invariant at %s',
    async (failpoint, expectedStatus) => {
      const canonicalValue = Buffer.from(`canonical bytes for ${failpoint}`)
      const name = `${createHash('sha256').update(canonicalValue).digest('hex')}.png`
      const key = `assets/${name}`
      const markerRelativePath = path.join('assets', '.legacy-hash-assets', name)
      const server = await spawnServer({
        env: { POCKETRISU_TEST_BULK_WRITE_FAILPOINT: `${failpoint}:0` },
        seedSave: async saveDir => {
          await mkdir(path.join(saveDir, 'assets', '.legacy-hash-assets'), {
            recursive: true,
          })
          await writeFile(path.join(saveDir, 'assets', name), Buffer.from('legacy mismatch'))
          await writeFile(
            path.join(saveDir, markerRelativePath),
            'legacy-hash-asset-v1\n',
          )
        },
      })
      servers.push(server)
      const client = await createClient(server.port, server.password)

      const { results } = await bulkWrite(client, [{ key, value: canonicalValue }])

      expect(results[0]).toMatchObject({
        status: expectedStatus,
        reconciled: true,
      })
      expect(await readOne(client, key)).toEqual(canonicalValue)
      const markerPath = path.join(server.cwd, 'save', markerRelativePath)
      if (expectedStatus === 'not-committed') {
        expect(await readFile(markerPath, 'utf-8')).toBe('legacy-hash-asset-v1\n')
      } else {
        await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }

      const restarted = await restartWithoutFailpoint(server)
      await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const retry = await bulkWrite(restarted, [{ key, value: canonicalValue }])
      expect(retry.results[0]).toMatchObject({
        status: 'committed',
        changed: false,
      })
    },
  )
})
