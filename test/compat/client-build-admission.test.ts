import { afterAll, describe, expect, test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { request as httpRequest, type ClientRequest } from 'node:http'
import path from 'node:path'
import { createClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const EXPECTED_BUILD = {
  version: '1.9.0',
  stamp: `1.9.0-${'d'.repeat(64)}`,
}
const KEY_HEX = Buffer.from('client-build/value', 'utf8').toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

async function seedBuildStamp(rootDir: string): Promise<void> {
  await mkdir(path.join(rootDir, 'dist'), { recursive: true })
  await writeFile(path.join(rootDir, 'dist', 'build-stamp.json'), JSON.stringify({
    ...EXPECTED_BUILD,
    hash: 'd'.repeat(64),
  }))
}

function openBodylessMutation(
  server: ServerHandle,
  token: string,
  requestPath = '/api/write',
): { request: ClientRequest; response: Promise<{ status: number; body: any }> } {
  let request: ClientRequest
  const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
    request = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: requestPath,
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '999999999',
        'file-path': KEY_HEX,
        'risu-auth': token,
        'x-client-build': '1.9.0-stale',
        connection: 'close',
      },
    }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: incoming.statusCode ?? 0,
          body: JSON.parse(text),
        })
      })
    })
    request.setTimeout(2_000, () => reject(new Error('server waited for a rejected body')))
    request.on('error', reject)
    request.flushHeaders()
  })
  return { request: request!, response }
}

describe('client build admission', () => {
  test('advertises the served build and rejects old clients before reading mutation bodies', async () => {
    const server = await spawnServer({ seedRoot: seedBuildStamp })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const session = await client.fetch('/api/session', {
      method: 'POST',
      headers: { 'x-session-id': 'build-admission-session' },
    })
    expect(session.status).toBe(200)
    await expect(session.json()).resolves.toMatchObject({ build: EXPECTED_BUILD })

    for (const headers of [
      {},
      { 'x-client-build': '1.9.0-stale' },
    ]) {
      const rejected = await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': KEY_HEX,
          'x-session-id': 'build-admission-session',
          ...headers,
        },
        body: 'old',
      })
      expect(rejected.status).toBe(426)
      await expect(rejected.json()).resolves.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
        expectedBuild: EXPECTED_BUILD,
        commitOutcome: 'not-committed',
      })
    }

    const bodyless = openBodylessMutation(server, client.token)
    await expect(bodyless.response).resolves.toMatchObject({
      status: 426,
      body: {
        code: 'CLIENT_UPGRADE_REQUIRED',
        expectedBuild: EXPECTED_BUILD,
      },
    })
    bodyless.request.destroy()

    const streamed = openBodylessMutation(
      server,
      client.token,
      '/api/plugin-storage/transition/stage/upload',
    )
    await expect(streamed.response).resolves.toMatchObject({
      status: 426,
      body: {
        code: 'CLIENT_UPGRADE_REQUIRED',
        expectedBuild: EXPECTED_BUILD,
      },
    })
    streamed.request.destroy()

    const matching = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': KEY_HEX,
        'x-session-id': 'build-admission-session',
        'x-client-build': EXPECTED_BUILD.stamp,
      },
      body: 'current',
    })
    expect(matching.status).toBe(200)

    const read = await client.fetch('/api/session/lock-status', {
      headers: { 'x-session-id': 'build-admission-session' },
    })
    expect(read.status).toBe(200)
  })

  test('fails open when the served dist has no readable stamp', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const response = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': KEY_HEX,
      },
      body: 'legacy-compatible',
    })
    expect(response.status).toBe(200)
  })
})
