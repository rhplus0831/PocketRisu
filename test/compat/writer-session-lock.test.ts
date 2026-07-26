import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

const KEY = `pluginsave/${Buffer.from('writer-lock-victim', 'utf-8').toString('base64url')}.json`
const KEY_HEX = Buffer.from(KEY, 'utf-8').toString('hex')
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
  await response.text()
}

function writeKey(client: RisuClient, sessionId: string, value: Buffer): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': KEY_HEX,
      'x-session-id': sessionId,
    },
    body: new Uint8Array(value),
  })
}

function readKey(client: RisuClient): Promise<Response> {
  return client.fetch('/api/read', { headers: { 'file-path': KEY_HEX } })
}

function removeKey(client: RisuClient, sessionId: string): Promise<Response> {
  return client.fetch('/api/remove', {
    headers: {
      'file-path': KEY_HEX,
      'x-session-id': sessionId,
    },
  })
}

describe('active writer session lock', () => {
  test('a displaced session cannot remove a value written by the active session', async () => {
    const server = await spawnServer()
    servers.push(server)

    const displacedClient = await createClient(server.port, server.password)
    const activeClient = await createClient(server.port, server.password)
    const displacedSessionId = 'writer-session-displaced'
    const activeSessionId = 'writer-session-active'

    await registerSession(displacedClient, displacedSessionId)
    expect((await writeKey(displacedClient, displacedSessionId, Buffer.from('{"version":1}'))).status).toBe(200)

    await registerSession(activeClient, activeSessionId)
    expect((await writeKey(activeClient, activeSessionId, Buffer.from('{"version":2}'))).status).toBe(200)

    const displacedRemove = await removeKey(displacedClient, displacedSessionId)
    expect(displacedRemove.status).toBe(423)
    await expect(displacedRemove.json()).resolves.toEqual({ error: 'Session deactivated' })

    const preserved = await readKey(activeClient)
    expect(preserved.status).toBe(200)
    expect(Buffer.from(await preserved.arrayBuffer())).toEqual(Buffer.from('{"version":2}'))

    expect((await removeKey(activeClient, activeSessionId)).status).toBe(200)
    const removed = await readKey(activeClient)
    expect(removed.status).toBe(200)
    expect((await removed.arrayBuffer()).byteLength).toBe(0)
  })
})
