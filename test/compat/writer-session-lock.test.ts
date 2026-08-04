import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

const KEY = 'writer-lock/victim.json'
const KEY_HEX = Buffer.from(KEY, 'utf-8').toString('hex')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

async function registerSession(client: RisuClient, sessionId: string): Promise<string> {
  const response = await client.fetch('/api/session', {
    method: 'POST',
    headers: { 'x-session-id': sessionId },
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { writerEpoch?: unknown }
  expect(typeof body.writerEpoch).toBe('string')
  expect(response.headers.get('x-writer-epoch')).toBe(body.writerEpoch)
  return body.writerEpoch as string
}

function writeKey(
  client: RisuClient,
  sessionId: string,
  value: Buffer,
  userActive = false,
  writerEpoch?: string,
): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': KEY_HEX,
      'x-session-id': sessionId,
      ...(writerEpoch ? { 'x-writer-epoch': writerEpoch } : {}),
      ...(userActive ? { 'x-user-active': '1' } : {}),
    },
    body: new Uint8Array(value),
  })
}

function readKey(client: RisuClient): Promise<Response> {
  return client.fetch('/api/read', { headers: { 'file-path': KEY_HEX } })
}

function removeKey(
  client: RisuClient,
  sessionId: string,
  writerEpoch?: string,
): Promise<Response> {
  return client.fetch('/api/remove', {
    headers: {
      'file-path': KEY_HEX,
      'x-session-id': sessionId,
      ...(writerEpoch ? { 'x-writer-epoch': writerEpoch } : {}),
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

    const displacedEpoch = await registerSession(displacedClient, displacedSessionId)
    expect((await writeKey(
      displacedClient,
      displacedSessionId,
      Buffer.from('{"version":1}'),
      false,
      displacedEpoch,
    )).status).toBe(200)

    const activeEpoch = await registerSession(activeClient, activeSessionId)
    expect((await writeKey(
      activeClient,
      activeSessionId,
      Buffer.from('{"version":2}'),
      true,
      activeEpoch,
    )).status).toBe(200)

    const displacedRemove = await removeKey(
      displacedClient,
      displacedSessionId,
      displacedEpoch,
    )
    expect(displacedRemove.status).toBe(423)
    await expect(displacedRemove.json()).resolves.toMatchObject({
      code: 'SESSION_DEACTIVATED',
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const preserved = await readKey(activeClient)
    expect(preserved.status).toBe(200)
    expect(Buffer.from(await preserved.arrayBuffer())).toEqual(Buffer.from('{"version":2}'))

    expect((await removeKey(activeClient, activeSessionId, activeEpoch)).status).toBe(200)
    const removed = await readKey(activeClient)
    expect(removed.status).toBe(200)
    expect((await removed.arrayBuffer()).byteLength).toBe(0)
  })

  test('a pre-restart epoch is fenced before adoption and a fresh session writes normally', async () => {
    const server = await spawnServer()
    servers.push(server)

    const beforeRestartClient = await createClient(server.port, server.password)
    const oldSessionId = 'writer-session-before-restart'
    const oldEpoch = await registerSession(beforeRestartClient, oldSessionId)
    expect((await writeKey(
      beforeRestartClient,
      oldSessionId,
      Buffer.from('{"version":"before-restart"}'),
      false,
      oldEpoch,
    )).status).toBe(200)

    await server.restart()
    const oldTabClient = await createClient(server.port, server.password)
    const status = await oldTabClient.fetch('/api/session/lock-status', {
      headers: {
        'x-session-id': oldSessionId,
        'x-writer-epoch': oldEpoch,
      },
    })
    expect(status.status).toBe(200)
    const statusBody = await status.json() as {
      state: string
      writerEpoch: string
    }
    expect(statusBody.state).toBe('stale')
    expect(statusBody.writerEpoch).not.toBe(oldEpoch)
    expect(status.headers.get('x-writer-epoch')).toBe(statusBody.writerEpoch)

    const fencedWrite = await writeKey(
      oldTabClient,
      oldSessionId,
      Buffer.from('{"version":"stale-overwrite"}'),
      true,
      oldEpoch,
    )
    expect(fencedWrite.status).toBe(423)
    await expect(fencedWrite.json()).resolves.toMatchObject({
      code: 'SESSION_DEACTIVATED',
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(fencedWrite.headers.get('x-writer-epoch')).toBe(statusBody.writerEpoch)

    const freshClient = await createClient(server.port, server.password)
    const freshEpoch = await registerSession(freshClient, 'writer-session-after-restart')
    expect(freshEpoch).toBe(statusBody.writerEpoch)
    expect((await writeKey(
      freshClient,
      'writer-session-after-restart',
      Buffer.from('{"version":"after-restart"}'),
      false,
      freshEpoch,
    )).status).toBe(200)

    const preserved = await readKey(freshClient)
    expect(Buffer.from(await preserved.arrayBuffer()))
      .toEqual(Buffer.from('{"version":"after-restart"}'))
  })
})
