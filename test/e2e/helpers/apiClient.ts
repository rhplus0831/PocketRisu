/**
 * Programmatic API client for template building. Unlike the compat-test
 * client, every request carries `x-client-build` from `dist/build-stamp.json`:
 * the E2E instances serve a real build, so writer-mutation admission enforces
 * the stamp (426 otherwise).
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PROJECT_ROOT } from './server.js'

export interface E2eApiClient {
  fetch: (urlPath: string, init?: RequestInit) => Promise<Response>
  importBackup: (data: Buffer) => Promise<{ ok: boolean; error?: string }>
}

export async function createE2eApiClient(port: number, passwordDigest: string): Promise<E2eApiClient> {
  const base = `http://127.0.0.1:${port}`
  const stamp = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, 'dist', 'build-stamp.json'), 'utf-8'),
  ).stamp as string

  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: passwordDigest }),
  })
  if (!loginRes.ok) {
    throw new Error(`E2E login failed (${loginRes.status}): ${await loginRes.text()}`)
  }
  const { token } = await loginRes.json() as { token: string }
  if (!token) throw new Error('E2E login returned no token')

  const authFetch = (urlPath: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('risu-auth', token)
    headers.set('x-client-build', stamp)
    return fetch(`${base}${urlPath}`, { ...init, headers })
  }

  const importBackup = async (data: Buffer) => {
    const prepRes = await authFetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: data.byteLength }),
    })
    if (!prepRes.ok) {
      throw new Error(`Import prepare failed (${prepRes.status}): ${await prepRes.text()}`)
    }
    const impRes = await authFetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(data),
    })
    return await impRes.json() as { ok: boolean; error?: string }
  }

  return { fetch: authFetch, importBackup }
}
