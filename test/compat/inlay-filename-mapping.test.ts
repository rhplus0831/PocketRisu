import path from 'node:path'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function hexPath(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
}

function canonicalPayloadPath(cwd: string, id: string, ext: string): string {
  const idChunks = Buffer.from(id).toString('hex').match(/.{1,120}/g)!
  const extChunks = Buffer.from(ext).toString('hex').match(/.{1,120}/g)!
  return path.join(
    cwd,
    'save',
    'inlays',
    '.inlay-objects-v1',
    'payload',
    'i',
    ...idChunks,
    'e',
    ...extChunks,
    'data',
  )
}

function canonicalSidecarPath(cwd: string, id: string): string {
  const idChunks = Buffer.from(id).toString('hex').match(/.{1,120}/g)!
  return path.join(
    cwd,
    'save',
    'inlays',
    '.inlay-objects-v1',
    'sidecar',
    'i',
    ...idChunks,
    'meta.json',
  )
}

function payload(id: string, ext: string, bytes: Buffer): Buffer {
  return Buffer.from(JSON.stringify({
    data: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
    ext,
    name: `${id}.${ext}`,
    type: 'image',
  }))
}

async function writeInlay(client: RisuClient, id: string, ext: string, bytes: Buffer): Promise<void> {
  const response = await requestWriteInlay(client, id, ext, bytes)
  expect(response.status).toBe(200)
  await response.text()
}

async function requestWriteInlay(
  client: RisuClient,
  id: string,
  ext: string,
  bytes: Buffer,
): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': hexPath(`inlay/${id}`),
    },
    body: new Uint8Array(payload(id, ext, bytes)),
  })
}

function canonicalIdFirstChunkDir(cwd: string, id: string, kind: 'payload' | 'sidecar'): string {
  const firstChunk = Buffer.from(id).toString('hex').slice(0, 120)
  return path.join(cwd, 'save', 'inlays', '.inlay-objects-v1', kind, 'i', firstChunk)
}

function canonicalExtFirstChunkDir(cwd: string, id: string, ext: string): string {
  const firstChunk = Buffer.from(ext).toString('hex').slice(0, 120)
  const idPath = canonicalPayloadPath(cwd, id, ext).split(`${path.sep}e${path.sep}`)[0]
  return path.join(idPath, 'e', firstChunk)
}

async function writeInlayInfo(client: RisuClient, id: string, ext: string): Promise<void> {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': hexPath(`inlay_info/${id}`),
    },
    body: new Uint8Array(Buffer.from(JSON.stringify({
      ext,
      name: `renamed-${id}`,
      type: 'image',
    }))),
  })
  expect(response.status).toBe(200)
  await response.text()
}

async function readInlay(client: RisuClient, id: string): Promise<Buffer | null> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': hexPath(`inlay/${id}`) },
  })
  expect(response.status).toBe(200)
  const encoded = Buffer.from(await response.arrayBuffer())
  if (encoded.length === 0) return null
  const parsed = JSON.parse(encoded.toString('utf-8')) as {
    data: string
  }
  return Buffer.from(parsed.data.slice(parsed.data.indexOf(',') + 1), 'base64')
}

async function removeKey(client: RisuClient, key: string): Promise<void> {
  const response = await client.fetch('/api/remove', {
    headers: { 'file-path': hexPath(key) },
  })
  expect(response.status).toBe(200)
  await response.text()
}

describe('injective inlay filename mapping', () => {
  test('dotted IDs, reserved suffixes, metadata removal, and deletion stay disjoint', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const baseBytes = Buffer.from('base-payload')
    const dottedBytes = Buffer.from('dotted-json-payload')
    const upperBytes = Buffer.from('upper-case-id')
    const lowerBytes = Buffer.from('lower-case-id')

    await writeInlay(client, 'x', 'png', baseBytes)
    await writeInlay(client, 'x.meta', 'json', dottedBytes)
    await writeInlay(client, 'Case', 'png', upperBytes)
    await writeInlay(client, 'case', 'png', lowerBytes)
    await writeInlayInfo(client, 'x', 'png')

    await expect(readInlay(client, 'x')).resolves.toEqual(baseBytes)
    await expect(readInlay(client, 'x.meta')).resolves.toEqual(dottedBytes)
    await expect(readInlay(client, 'Case')).resolves.toEqual(upperBytes)
    await expect(readInlay(client, 'case')).resolves.toEqual(lowerBytes)
    await expect(access(canonicalPayloadPath(server.cwd, 'x.meta', 'json'))).resolves
      .toBeUndefined()

    await removeKey(client, 'inlay_info/x')
    await expect(readInlay(client, 'x.meta')).resolves.toEqual(dottedBytes)
    await expect(access(canonicalSidecarPath(server.cwd, 'x.meta'))).resolves.toBeUndefined()

    await removeKey(client, 'inlay/x')
    await expect(readInlay(client, 'x')).resolves.toBeNull()
    await expect(readInlay(client, 'x.meta')).resolves.toEqual(dottedBytes)
  }, 60_000)

  test('portable target collisions are rejected before publication', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const target = canonicalPayloadPath(server.cwd, 'collision', 'png')
    const alias = path.join(path.dirname(target), path.basename(target).toUpperCase())
    await mkdir(path.dirname(alias), { recursive: true })
    await writeFile(alias, 'foreign-case-alias')

    const response = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': hexPath('inlay/collision'),
      },
      body: new Uint8Array(payload('collision', 'png', Buffer.from('must-not-publish'))),
    })
    expect(response.status).toBe(500)
    await response.text()
    await expect(readInlay(client, 'collision')).resolves.toBeNull()
    await expect(access(alias)).resolves.toBeUndefined()
  }, 60_000)

  test('legacy missing-sidecar lookup and deletion require exact parsed IDs', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const inlayDir = path.join(server.cwd, 'save', 'inlays')
    const prefixBytes = Buffer.from('prefix-sharing-payload')
    const reservedBytes = Buffer.from('reserved-dotted-payload')

    await writeFile(path.join(inlayDir, 'prefix.long.png'), prefixBytes)
    await writeFile(path.join(inlayDir, 'legacy.meta.json'), reservedBytes)
    await writeFile(path.join(inlayDir, 'legacy.meta.meta.json'), JSON.stringify({
      ext: 'json',
      name: 'legacy.meta.json',
      type: 'image',
    }))

    await expect(readInlay(client, 'prefix')).resolves.toBeNull()
    await expect(readInlay(client, 'prefix.long')).resolves.toEqual(prefixBytes)
    await expect(readInlay(client, 'legacy')).resolves.toBeNull()
    await expect(readInlay(client, 'legacy.meta')).resolves.toEqual(reservedBytes)

    await removeKey(client, 'inlay/prefix')
    await removeKey(client, 'inlay/legacy')
    await expect(readInlay(client, 'prefix.long')).resolves.toEqual(prefixBytes)
    await expect(readInlay(client, 'legacy.meta')).resolves.toEqual(reservedBytes)
  }, 60_000)

  test('backup list and import retain dotted logical IDs while physical names stay canonical', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    expect(await sourceClient.importBackup(createSeedBackup({ characterCount: 0 })))
      .toMatchObject({ ok: true })
    const bytes = Buffer.from('archive-dotted-payload')
    await writeInlay(sourceClient, 'archive.meta', 'json', bytes)

    const listResponse = await sourceClient.fetch('/api/list', {
      headers: { 'key-prefix': 'inlay/' },
    })
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toMatchObject({
      mode: 'full',
      content: ['inlay/archive.meta'],
    })

    const archive = await sourceClient.exportBackup()
    const names = decodeBackup(archive).map(entry => entry.name)
    expect(names).toContain('inlay/archive.meta.json')
    expect(names).toContain('inlay_sidecar/archive.meta')

    const restored = await spawnServer()
    servers.push(restored)
    const restoredClient = await createClient(restored.port, restored.password)
    expect(await restoredClient.importBackup(archive)).toMatchObject({ ok: true })
    await expect(readInlay(restoredClient, 'archive.meta')).resolves.toEqual(bytes)
    await expect(readInlay(restoredClient, 'archive')).resolves.toBeNull()
    await expect(access(canonicalPayloadPath(restored.cwd, 'archive.meta', 'json'))).resolves
      .toBeUndefined()
  }, 90_000)

  test('archive names keep dotted extension tuples injective across restore', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    expect(await sourceClient.importBackup(createSeedBackup({ characterCount: 0 })))
      .toMatchObject({ ok: true })
    const baseBytes = Buffer.from('base-meta-json-extension')
    const dottedBytes = Buffer.from('dotted-json-extension')
    await writeInlay(sourceClient, 'x', 'meta.json', baseBytes)
    await writeInlay(sourceClient, 'x.meta', 'json', dottedBytes)

    const archive = await sourceClient.exportBackup()
    const names = decodeBackup(archive).map(entry => entry.name)
    const encodedBaseName = `inlay_v2/${Buffer.from('x').toString('hex')}`
      + `--${Buffer.from('meta.json').toString('hex')}`
    expect(names).toContain(encodedBaseName)
    expect(names).toContain('inlay/x.meta.json')
    expect(new Set(names).size).toBe(names.length)

    const restored = await spawnServer()
    servers.push(restored)
    const restoredClient = await createClient(restored.port, restored.password)
    expect(await restoredClient.importBackup(archive)).toMatchObject({ ok: true })
    await expect(readInlay(restoredClient, 'x')).resolves.toEqual(baseBytes)
    await expect(readInlay(restoredClient, 'x.meta')).resolves.toEqual(dottedBytes)
  }, 90_000)

  test('backup import rejects over-limit inlay tuples without changing live files', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect(await client.importBackup(createSeedBackup({ characterCount: 0 })))
      .toMatchObject({ ok: true })
    const liveBytes = Buffer.from('live-before-invalid-import')
    await writeInlay(client, 'live', 'png', liveBytes)
    const seedEntries = decodeBackup(createSeedBackup({ characterCount: 0 }))
    const invalidNames = [
      `inlay_v2/${Buffer.from('z'.repeat(246)).toString('hex')}--${Buffer.from('png').toString('hex')}`,
      `inlay_v2/${Buffer.from('id').toString('hex')}--${Buffer.from('q'.repeat(253)).toString('hex')}`,
      `inlay_sidecar/${'s'.repeat(246)}`,
    ]

    for (const name of invalidNames) {
      const result = await client.importBackup(encodeBackup([
        ...seedEntries,
        { name, data: Buffer.from('invalid-inlay-entry') },
      ]))
      expect(result).toMatchObject({
        code: 'INVALID_INLAY_BACKUP_ENTRY',
        commitOutcome: 'not-committed',
      })
      await expect(readInlay(client, 'live')).resolves.toEqual(liveBytes)
      await expect(access(path.join(server.cwd, 'save', 'inlays_import_staging'))).rejects
        .toMatchObject({ code: 'ENOENT' })
    }
  }, 90_000)

  test('sharded paths preserve the historical byte envelope through restore', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    expect(await sourceClient.importBackup(createSeedBackup({ characterCount: 0 })))
      .toMatchObject({ ok: true })
    const boundaryId = 'a'.repeat(245)
    const boundaryExt = 'n'.repeat(9)
    const maxExtensionId = 'id'
    const maxExtension = 'e'.repeat(252)
    const multibyteId = '界'.repeat(80)
    const multibyteExt = '확장.δ'
    const boundaryBytes = Buffer.from('boundary-id-payload')
    const maxExtensionBytes = Buffer.from('boundary-extension-payload')
    const multibyteBytes = Buffer.from('multibyte-id-extension-payload')
    await writeInlay(sourceClient, boundaryId, boundaryExt, boundaryBytes)
    await writeInlay(sourceClient, maxExtensionId, maxExtension, maxExtensionBytes)
    await writeInlay(sourceClient, multibyteId, multibyteExt, multibyteBytes)
    await expect(access(canonicalPayloadPath(source.cwd, boundaryId, boundaryExt))).resolves
      .toBeUndefined()
    await expect(access(canonicalPayloadPath(source.cwd, maxExtensionId, maxExtension))).resolves
      .toBeUndefined()
    await expect(access(canonicalPayloadPath(source.cwd, multibyteId, multibyteExt))).resolves
      .toBeUndefined()

    const archive = await sourceClient.exportBackup()
    const restored = await spawnServer()
    servers.push(restored)
    const restoredClient = await createClient(restored.port, restored.password)
    expect(await restoredClient.importBackup(archive)).toMatchObject({ ok: true })
    await expect(readInlay(restoredClient, boundaryId)).resolves.toEqual(boundaryBytes)
    await expect(readInlay(restoredClient, maxExtensionId)).resolves
      .toEqual(maxExtensionBytes)
    await expect(readInlay(restoredClient, multibyteId)).resolves.toEqual(multibyteBytes)
  }, 90_000)

  test('over-limit IDs, extensions, and combined tuples reject before path creation', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const bytes = Buffer.from('must-not-publish')
    const invalidCases = [
      { id: 'z'.repeat(246), ext: 'png', sideEffect: canonicalIdFirstChunkDir(server.cwd, 'z'.repeat(246), 'payload') },
      { id: 'ox', ext: 'q'.repeat(253), sideEffect: canonicalExtFirstChunkDir(server.cwd, 'ox', 'q'.repeat(253)) },
      { id: 'c'.repeat(245), ext: 'r'.repeat(10), sideEffect: canonicalIdFirstChunkDir(server.cwd, 'c'.repeat(245), 'sidecar') },
      { id: '語'.repeat(82), ext: 'png', sideEffect: canonicalIdFirstChunkDir(server.cwd, '語'.repeat(82), 'payload') },
    ]

    for (const invalid of invalidCases) {
      const response = await requestWriteInlay(client, invalid.id, invalid.ext, bytes)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_INLAY_TUPLE' })
      await expect(access(invalid.sideEffect)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 60_000)

  test('storage and direct-asset transports reject malformed UTF-8 hex aliases', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const body = payload('unused', 'png', Buffer.from('invalid-transport'))
    const invalidPrefix = Buffer.from('inlay/invalid-', 'utf8').toString('hex')
    const sessionResponse = await client.fetch('/api/session', { method: 'POST' })
    expect(sessionResponse.status).toBe(200)
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeTruthy()
    for (const filePath of [`${invalidPrefix}ff`, `${invalidPrefix}fe`, 'abc']) {
      const writeResponse = await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': filePath,
        },
        body: new Uint8Array(body),
      })
      expect(writeResponse.status).toBe(400)
      await writeResponse.text()

      const directResponse = await client.fetch(`/api/asset/${filePath}`, {
        headers: { cookie: cookie! },
      })
      expect(directResponse.status).toBe(400)
      await expect(directResponse.json()).resolves.toMatchObject({ code: 'INVALID_HEX_PATH' })
    }

    const literalId = 'invalid-�'
    const literalBytes = Buffer.from('literal-replacement-character')
    await writeInlay(client, literalId, 'png', literalBytes)
    await expect(readInlay(client, literalId)).resolves.toEqual(literalBytes)
    const directResponse = await client.fetch(`/api/asset/${hexPath(`inlay/${literalId}`)}`, {
      headers: { cookie: cookie! },
    })
    expect(directResponse.status).toBe(200)
    expect(Buffer.from(await directResponse.arrayBuffer())).toEqual(literalBytes)
  }, 60_000)

  test('startup canonicalizes evidenced dotted payloads and exact missing-sidecar files', async () => {
    const server = await spawnServer()
    servers.push(server)
    await server.crash()
    const inlayDir = path.join(server.cwd, 'save', 'inlays')
    await mkdir(inlayDir, { recursive: true })
    const reservedBytes = Buffer.from('migrated-reserved-payload')
    const prefixBytes = Buffer.from('migrated-prefix-payload')
    const orphanBytes = Buffer.from('canonical-orphan-payload')
    const boundaryId = 'b'.repeat(124)
    const boundaryBytes = Buffer.from('migrated-boundary-payload')
    await writeFile(path.join(inlayDir, 'migrate.meta.json'), reservedBytes)
    await writeFile(path.join(inlayDir, 'migrate.meta.meta.json'), JSON.stringify({
      ext: 'json',
      name: 'migrate.meta.json',
      type: 'image',
    }))
    await writeFile(path.join(inlayDir, 'prefix.shared.png'), prefixBytes)
    await writeFile(path.join(inlayDir, `${boundaryId}.png`), boundaryBytes)
    await writeFile(path.join(inlayDir, `${boundaryId}.meta.json`), JSON.stringify({
      ext: 'png',
      name: `${boundaryId}.png`,
      type: 'image',
    }))
    const canonicalOrphanPath = canonicalPayloadPath(server.cwd, 'canonical.orphan', 'png')
    await mkdir(path.dirname(canonicalOrphanPath), { recursive: true })
    await writeFile(canonicalOrphanPath, orphanBytes)

    await server.restart()
    const client = await createClient(server.port, server.password)
    await expect(readInlay(client, 'migrate.meta')).resolves.toEqual(reservedBytes)
    await expect(readInlay(client, 'migrate')).resolves.toBeNull()
    await expect(readInlay(client, 'prefix.shared')).resolves.toEqual(prefixBytes)
    await expect(readInlay(client, 'prefix')).resolves.toBeNull()
    await expect(readInlay(client, 'canonical.orphan')).resolves.toEqual(orphanBytes)
    await expect(readInlay(client, boundaryId)).resolves.toEqual(boundaryBytes)
    await expect(access(path.join(inlayDir, 'migrate.meta.json'))).rejects
      .toMatchObject({ code: 'ENOENT' })
    await expect(access(canonicalPayloadPath(server.cwd, 'migrate.meta', 'json'))).resolves
      .toBeUndefined()
    await expect(access(canonicalPayloadPath(server.cwd, 'prefix.shared', 'png'))).resolves
      .toBeUndefined()
    await expect(access(canonicalSidecarPath(server.cwd, 'canonical.orphan'))).resolves
      .toBeUndefined()
    await expect(access(canonicalPayloadPath(server.cwd, boundaryId, 'png'))).resolves
      .toBeUndefined()
    await expect(access(path.join(inlayDir, `${boundaryId}.png`))).rejects
      .toMatchObject({ code: 'ENOENT' })
  }, 60_000)
})
