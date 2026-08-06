import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import bufferedIngressPkg from '../../server/node/chat/bufferedIngress.cjs'
import admittedSpoolPkg from '../../server/node/chat/admittedIngressSpool.cjs'

const {
  BUFFERED_INGRESS_POLICY,
  createBufferedIngressMiddleware,
  createInFlightByteBudget,
} = bufferedIngressPkg as any
const {
  ADMITTED_INGRESS_SPOOL,
  SPOOL_PAGE_BYTES,
  admittedIngressSpoolMetrics,
  createAdmittedIngressSpoolMiddleware,
  resetAdmittedIngressSpoolMetricsForTests,
} = admittedSpoolPkg as any

const MIB = 1024 * 1024
const PAYLOAD_SIZE_S = 4 * MIB
const ADMITTED_WRITES = 3
const REQUEST_COUNT_N = 9
const INGRESS_BUDGET = PAYLOAD_SIZE_S * ADMITTED_WRITES

class FakeResponse extends EventEmitter {
  statusCode = 200
  body: unknown = null
  headers = new Map<string, string>()
  writableEnded = false
  destroyed = false
  onResult: (() => void) | null = null

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }

  status(value: number) {
    this.statusCode = value
    return this
  }

  json(value: unknown) {
    this.body = value
    this.writableEnded = true
    this.onResult?.()
    return this
  }
}

type TestRequest = Readable & Record<any, any>

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  resetAdmittedIngressSpoolMetricsForTests()
})

function largeWriteRequest(sharedPayload: Buffer): TestRequest {
  const req = Readable.from([sharedPayload]) as TestRequest
  req.method = 'POST'
  req.path = '/api/write'
  req.headers = {
    'content-length': String(sharedPayload.byteLength),
    'content-type': 'application/octet-stream',
  }
  req.destroyed = false
  return req
}

async function runAdmission(
  middleware: (req: TestRequest, res: FakeResponse, next: (error?: unknown) => void) => void,
  req: TestRequest,
): Promise<{ admitted: boolean; req: TestRequest; res: FakeResponse }> {
  const res = new FakeResponse()
  return new Promise((resolve, reject) => {
    res.onResult = () => resolve({ admitted: false, req, res })
    middleware(req, res, (error?: unknown) => {
      if (error) reject(error)
      else resolve({ admitted: true, req, res })
    })
  })
}

async function spoolAdmitted(
  middleware: (req: TestRequest, res: FakeResponse, next: (error?: unknown) => void) => void,
  admitted: { req: TestRequest; res: FakeResponse },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    middleware(admitted.req, admitted.res, (error?: unknown) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

describe('concurrent ingress budget', () => {
  test('admits at most budget/S large writes and spools them in fixed pages', async () => {
    const cacheMode = process.env.POCKETRISU_PERF_RESOURCE_CACHE
    expect(['off', 'on']).toContain(cacheMode)

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-perf-ingress-'))
    roots.push(root)
    const budget = createInFlightByteBudget(INGRESS_BUDGET)
    const policy = {
      maxBytes: INGRESS_BUDGET,
      responseKind: 'generic',
      bodyKind: 'raw',
      authMode: 'jwt',
      writer: true,
      admissionOnly: false,
    }
    const admission = createBufferedIngressMiddleware({
      resolvePolicy: () => policy,
      budget,
      authenticate: async () => true,
      authenticateCookie: () => true,
      writerState: () => 'active',
    })
    const spool = createAdmittedIngressSpoolMiddleware({
      policySymbol: BUFFERED_INGRESS_POLICY,
      spoolDir: () => root,
      globalBudgetBytes: INGRESS_BUDGET,
    })

    // The client fixture shares source bytes intentionally: this scenario
    // budgets server-side admission and spool working pages, not test-client RSS.
    const sharedPayload = Buffer.alloc(PAYLOAD_SIZE_S, 0x6a)
    const attempts = await Promise.all(
      Array.from({ length: REQUEST_COUNT_N }, () => (
        runAdmission(admission, largeWriteRequest(sharedPayload))
      )),
    )
    const admitted = attempts.filter(result => result.admitted)
    const refused = attempts.filter(result => !result.admitted)

    expect(admitted).toHaveLength(ADMITTED_WRITES)
    expect(refused).toHaveLength(REQUEST_COUNT_N - ADMITTED_WRITES)
    expect(budget.snapshot()).toEqual({
      maxBytes: INGRESS_BUDGET,
      usedBytes: INGRESS_BUDGET,
      availableBytes: 0,
    })
    for (const result of refused) {
      expect(result.res.statusCode).toBe(503)
      expect(result.res.body).toMatchObject({
        code: 'BUFFERED_INGRESS_BUSY',
        limit: INGRESS_BUDGET,
        retryable: true,
        commitOutcome: 'not-committed',
      })
      result.req.destroy()
    }

    await Promise.all(admitted.map(result => spoolAdmitted(spool, result)))
    const metrics = admittedIngressSpoolMetrics()
    expect(metrics).toMatchObject({
      requests: ADMITTED_WRITES,
      bytes: INGRESS_BUDGET,
      maxPageBytes: SPOOL_PAGE_BYTES,
      maxActive: ADMITTED_WRITES,
    })
    expect(metrics.maxActive * metrics.maxPageBytes).toBeLessThanOrEqual(
      ADMITTED_WRITES * SPOOL_PAGE_BYTES,
    )
    expect(metrics.maxActive * metrics.maxPageBytes).toBeLessThan(PAYLOAD_SIZE_S)

    for (const result of admitted) {
      const retained = result.req[ADMITTED_INGRESS_SPOOL]
      expect(result.req.body).toBeUndefined()
      expect(retained).toMatchObject({
        size: PAYLOAD_SIZE_S,
        maxPageBytes: SPOOL_PAGE_BYTES,
      })
      expect(fs.statSync(retained.filePath).size).toBe(PAYLOAD_SIZE_S)
      result.res.emit('finish')
      await retained.dispose()
    }
    expect(budget.snapshot().usedBytes).toBe(0)
  })
})
