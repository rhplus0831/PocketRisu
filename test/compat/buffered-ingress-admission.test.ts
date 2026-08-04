import { afterAll, describe, expect, test } from 'vitest'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

const KEY_HEX = Buffer.from('buffered-ingress/value.json', 'utf8').toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

async function registerSession(client: RisuClient, sessionId: string): Promise<void> {
  const response = await client.fetch('/api/session', {
    method: 'POST',
    headers: { 'x-session-id': sessionId },
  })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
}

function openRequest(
  server: ServerHandle,
  headers: Record<string, string>,
): { request: ClientRequest; response: Promise<{ status: number; body: unknown }> } {
  let request: ClientRequest
  const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    request = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/write',
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': KEY_HEX,
        connection: 'close',
        ...headers,
      },
    }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try { body = JSON.parse(text) } catch {}
        resolve({ status: incoming.statusCode ?? 0, body })
      })
    })
    request.setTimeout(2_000, () => reject(new Error('server waited for a rejected body')))
    request.on('error', reject)
    request.flushHeaders()
  })
  return { request: request!, response }
}

async function write(
  client: RisuClient,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': KEY_HEX,
      ...headers,
    },
    body,
  })
}

describe('buffered ingress admission', () => {
  test('rejects unauthenticated and stale writers before waiting for their bodies', async () => {
    const server = await spawnServer()
    servers.push(server)

    const unauthenticated = openRequest(server, { 'content-length': '999999999' })
    await expect(unauthenticated.response).resolves.toMatchObject({
      status: 400,
      body: { error: 'No auth header' },
    })
    unauthenticated.request.destroy()

    const displaced = await createClient(server.port, server.password)
    const active = await createClient(server.port, server.password)
    await registerSession(displaced, 'buffered-displaced')
    expect((await write(displaced, 'old', { 'x-session-id': 'buffered-displaced' })).status)
      .toBe(200)
    await registerSession(active, 'buffered-active')
    expect((await write(active, 'new', {
      'x-session-id': 'buffered-active',
      'x-user-active': '1',
    })).status).toBe(200)

    const stale = openRequest(server, {
      'content-length': '999999999',
      'risu-auth': displaced.token,
      'x-session-id': 'buffered-displaced',
    })
    await expect(stale.response).resolves.toEqual({
      status: 423,
      body: {
        error: 'Session deactivated',
        code: 'SESSION_DEACTIVATED',
        retryable: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
      },
    })
    stale.request.destroy()
  })

  test('requires Content-Length and rejects over-limit bodies from headers alone', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_KV_WRITE_MAX_BYTES: '32' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const chunked = openRequest(server, {
      'transfer-encoding': 'chunked',
      'risu-auth': client.token,
    })
    await expect(chunked.response).resolves.toMatchObject({
      status: 411,
      body: {
        code: 'BUFFERED_INGRESS_LENGTH_REQUIRED',
        commitOutcome: 'not-committed',
      },
    })
    chunked.request.destroy()

    const tooLarge = openRequest(server, {
      'content-length': '33',
      'risu-auth': client.token,
    })
    await expect(tooLarge.response).resolves.toMatchObject({
      status: 413,
      body: {
        code: 'BUFFERED_INGRESS_TOO_LARGE',
        limit: 32,
        actual: 33,
        commitOutcome: 'not-committed',
      },
    })
    tooLarge.request.destroy()
  })

  test('bounds concurrent parser reservations and releases aborted requests', async () => {
    const server = await spawnServer({
      env: {
        POCKETRISU_BUFFERED_INGRESS_MAX_BYTES: '64',
        POCKETRISU_KV_WRITE_MAX_BYTES: '64',
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const held = openRequest(server, {
      'content-length': '48',
      'risu-auth': client.token,
    })
    held.request.write('a')
    await new Promise(resolve => setTimeout(resolve, 30))

    const busy = openRequest(server, {
      'content-length': '32',
      'risu-auth': client.token,
    })
    await expect(busy.response).resolves.toMatchObject({
      status: 503,
      body: {
        code: 'BUFFERED_INGRESS_BUSY',
        retryable: true,
        commitOutcome: 'not-committed',
      },
    })
    busy.request.destroy()
    held.request.destroy()
    await held.response.catch(() => undefined)

    let stored: Response | null = null
    for (let attempt = 0; attempt < 20; attempt++) {
      stored = await write(client, 'done')
      if (stored.status !== 503) break
      await stored.arrayBuffer()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(stored?.status).toBe(200)
  })
})
