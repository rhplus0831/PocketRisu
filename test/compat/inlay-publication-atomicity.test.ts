import path from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  access,
  mkdir,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function hexPath(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
}

function isInlayTemporaryFile(entry: string): boolean {
  return /^\.inlay-publish-\d+-[0-9a-f-]{36}-(?:payload|sidecar)$/i.test(entry)
}

function canonicalInlayPayloadPath(cwd: string, id: string, ext: string): string {
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

function canonicalInlaySidecarPath(cwd: string, id: string): string {
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

function inlayPayload(id: string, ext: string, data: Buffer): Buffer {
  return Buffer.from(JSON.stringify({
    data: `data:image/${ext};base64,${data.toString('base64')}`,
    ext,
    name: `${id}.${ext}`,
    type: 'image',
    width: 1,
    height: 1,
  }))
}

async function writeInlay(
  client: RisuClient,
  id: string,
  ext: string,
  data: Buffer,
): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': hexPath(`inlay/${id}`),
    },
    body: new Uint8Array(inlayPayload(id, ext, data)),
  })
}

async function readInlay(
  client: RisuClient,
  id: string,
): Promise<{ ext: string, data: Buffer }> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': hexPath(`inlay/${id}`) },
  })
  expect(response.status).toBe(200)
  const encoded = Buffer.from(await response.arrayBuffer())
  const parsed = JSON.parse(encoded.toString('utf-8')) as { ext: string, data: string }
  return {
    ext: parsed.ext,
    data: Buffer.from(parsed.data.slice(parsed.data.indexOf(',') + 1), 'base64'),
  }
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

describe('atomic inlay publication', () => {
  test('a staged replacement failure preserves the original payload and sidecar', async () => {
    const server = await spawnServer()
    servers.push(server)
    let client = await createClient(server.port, server.password)
    const original = Buffer.from('original-png-payload')
    const replacement = Buffer.from('replacement-jpeg-payload')
    const id = '.inlay-publish-123-123e4567-e89b-42d3-a456-426614174000-payload'

    const initialWrite = await writeInlay(client, id, 'png', original)
    expect(initialWrite.status).toBe(200)
    await initialWrite.text()

    await server.restart({
      POCKETRISU_TEST_INLAY_PUBLISH_FAILPOINT: 'before-payload-publish',
    })
    client = await createClient(server.port, server.password)
    const failedWrite = await writeInlay(client, id, 'jpeg', replacement)
    expect(failedWrite.status).toBe(500)
    await failedWrite.text()

    await expect(readInlay(client, id)).resolves.toEqual({
      ext: 'png',
      data: original,
    })
    await expect(access(canonicalInlayPayloadPath(server.cwd, id, 'png'))).resolves
      .toBeUndefined()
    await expect(access(canonicalInlayPayloadPath(server.cwd, id, 'jpeg'))).rejects
      .toMatchObject({ code: 'ENOENT' })
    const entries = await readdir(path.join(server.cwd, 'save', 'inlays'))
    expect(entries.some(isInlayTemporaryFile)).toBe(false)
  }, 60_000)

  test('compression reports a publication error and preserves its PNG source', async () => {
    const server = await spawnServer()
    servers.push(server)
    let client = await createClient(server.port, server.password)
    const original = solidPng(256, 256)
    const initialWrite = await writeInlay(client, 'compress-failure', 'png', original)
    expect(initialWrite.status).toBe(200)
    await initialWrite.text()

    await server.restart({
      POCKETRISU_TEST_INLAY_PUBLISH_FAILPOINT: 'after-payload-publish',
    })
    client = await createClient(server.port, server.password)
    const sessionResponse = await client.fetch('/api/session', { method: 'POST' })
    expect(sessionResponse.status).toBe(200)
    const sessionCookie = sessionResponse.headers.get('set-cookie')!.split(';', 1)[0]

    const compressionResponse = await client.fetch('/api/inlays/compress', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: sessionCookie,
      },
      body: JSON.stringify({ quality: 80 }),
    })
    expect(compressionResponse.status).toBe(200)
    const events = await compressionResponse.text()
    expect(events).toContain('"type":"error"')
    expect(events).toContain('"code":"INLAY_PUBLICATION_FAILED"')
    expect(events).not.toContain('"type":"done"')

    await expect(readInlay(client, 'compress-failure')).resolves.toEqual({
      ext: 'png',
      data: original,
    })
    await expect(access(canonicalInlayPayloadPath(server.cwd, 'compress-failure', 'webp')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const entries = await readdir(path.join(server.cwd, 'save', 'inlays'))
    expect(entries.some(isInlayTemporaryFile)).toBe(false)
  }, 120_000)

  test('a process kill between payload and sidecar publication keeps the old inlay readable', async () => {
    const server = await spawnServer()
    servers.push(server)
    let client = await createClient(server.port, server.password)
    const original = Buffer.from('source-that-must-survive')
    const replacement = Buffer.from('new-payload-before-crash')
    const initialWrite = await writeInlay(client, 'crash', 'png', original)
    expect(initialWrite.status).toBe(200)
    await initialWrite.text()

    const gateDir = path.join(server.cwd, 'inlay-publish-gate')
    await mkdir(gateDir, { recursive: true })
    await writeFile(path.join(gateDir, 'hold'), '')
    await server.restart({
      POCKETRISU_TEST_INLAY_PUBLISH_GATE_DIR: gateDir,
      POCKETRISU_TEST_INLAY_PUBLISH_GATE_STAGE: 'after-payload-publish',
    })
    client = await createClient(server.port, server.password)
    const interruptedWrite = writeInlay(client, 'crash', 'jpeg', replacement)
      .then(response => response.text())
      .catch(() => '')
    await waitForFile(path.join(gateDir, 'entered'))
    await server.crash()
    await interruptedWrite

    await server.restart()
    client = await createClient(server.port, server.password)
    await expect(readInlay(client, 'crash')).resolves.toEqual({
      ext: 'png',
      data: original,
    })
    await expect(access(canonicalInlayPayloadPath(server.cwd, 'crash', 'png'))).resolves
      .toBeUndefined()
    await expect(access(canonicalInlayPayloadPath(server.cwd, 'crash', 'jpeg'))).resolves
      .toBeUndefined()
    const entries = await readdir(path.join(server.cwd, 'save', 'inlays'))
    expect(entries.some(isInlayTemporaryFile)).toBe(false)

    const sidecarSize = (await stat(canonicalInlaySidecarPath(server.cwd, 'crash'))).size
    const statsResponse = await client.fetch('/api/db/stats')
    expect(statsResponse.status).toBe(200)
    await expect(statsResponse.json()).resolves.toMatchObject({
      inlayFsBytes: original.length + replacement.length + sidecarSize,
    })
  }, 90_000)
})
