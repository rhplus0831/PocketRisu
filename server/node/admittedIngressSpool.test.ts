import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ingressPkg from './admittedIngressSpool.cjs'

const {
  ADMITTED_INGRESS_SPOOL,
  SPOOL_PAGE_BYTES,
  createAdmittedIngressSpoolMiddleware,
  admittedIngressSpoolMetrics,
  resetAdmittedIngressSpoolMetricsForTests,
} = ingressPkg as any

class FakeResponse extends EventEmitter {
  statusCode = 200
  body: unknown = null
  headers = new Map<string, string>()
  writableEnded = false
  destroyed = false
  setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value) }
  status(value: number) { this.statusCode = value; return this }
  json(value: unknown) { this.body = value; return this }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  resetAdmittedIngressSpoolMetricsForTests()
})

function request(body: Buffer, policySymbol: symbol) {
  const req = Readable.from([body]) as Readable & Record<any, any>
  req.method = 'POST'
  req.path = '/api/write'
  req.headers = { 'content-length': String(body.length) }
  req[policySymbol] = {
    bodyKind: 'raw',
    admissionOnly: false,
    responseKind: 'generic',
    maxBytes: body.length,
  }
  return req
}

describe('admitted ingress disk spool', () => {
  test('bypasses req.body and writes even one payload-sized source chunk in bounded pages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-admitted-spool-'))
    roots.push(root)
    const policySymbol = Symbol('policy')
    const body = Buffer.alloc(SPOOL_PAGE_BYTES * 9 + 13, 0x6a)
    const req = request(body, policySymbol)
    const res = new FakeResponse()
    const next = vi.fn()
    const middleware = createAdmittedIngressSpoolMiddleware({
      policySymbol,
      spoolDir: () => root,
      globalBudgetBytes: body.length,
    })

    await middleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.body).toBeUndefined()
    expect(req[ADMITTED_INGRESS_SPOOL]).toMatchObject({
      size: body.length,
      maxPageBytes: SPOOL_PAGE_BYTES,
    })
    expect(fs.readFileSync(req[ADMITTED_INGRESS_SPOOL].filePath)).toEqual(body)
    expect(admittedIngressSpoolMetrics()).toMatchObject({
      requests: 1,
      bytes: body.length,
      maxPageBytes: SPOOL_PAGE_BYTES,
      maxActive: 1,
    })

    res.emit('finish')
    await vi.waitFor(() => expect(fs.existsSync(req[ADMITTED_INGRESS_SPOOL].filePath)).toBe(false))
  })

  test('maps an unavailable spool volume to the admission layer retryable refusal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-admitted-spool-fail-'))
    roots.push(root)
    const missing = path.join(root, 'missing')
    const policySymbol = Symbol('policy')
    const req = request(Buffer.from('payload'), policySymbol)
    const res = new FakeResponse()
    const next = vi.fn()
    const middleware = createAdmittedIngressSpoolMiddleware({
      policySymbol,
      spoolDir: () => missing,
      globalBudgetBytes: 512,
    })

    await middleware(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(res.body).toEqual({
      error: 'The server is already buffering its configured ingress budget. Retry shortly.',
      code: 'BUFFERED_INGRESS_BUSY',
      limit: 512,
      actual: 7,
      retryable: true,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
  })
})
