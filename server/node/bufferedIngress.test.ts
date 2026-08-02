import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'

const {
  BUFFERED_INGRESS_POLICY,
  createBufferedIngressLimits,
  createBufferedIngressMiddleware,
  createInFlightByteBudget,
  createRoutePolicyResolver,
  isStreamedIngress,
  parseContentLength,
} = require('./bufferedIngress.cjs')

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    path: '/api/write',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': '8',
      'file-path': Buffer.from('example/key', 'utf8').toString('hex'),
    },
    ...overrides,
  }
}

class FakeResponse extends EventEmitter {
  statusCode = 200
  headers = new Map<string, string>()
  body: unknown = null

  status(code: number) {
    this.statusCode = code
    return this
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }

  json(body: unknown) {
    this.body = body
    return this
  }
}

function limits(env: Record<string, string> = {}) {
  return createBufferedIngressLimits({
    env,
    pluginValueMaxBytes: 128,
    pluginStorageMaxBytes: 1024,
    pluginBatchMaxBytes: 64,
  })
}

function middleware({
  budget = createInFlightByteBudget(32),
  authenticate = vi.fn(async () => true),
  writerState = vi.fn(() => 'active'),
} = {}) {
  return {
    budget,
    authenticate,
    writerState,
    run: createBufferedIngressMiddleware({
      resolvePolicy: createRoutePolicyResolver({ ...limits(), global: budget.maxBytes }),
      budget,
      authenticate,
      authenticateCookie: vi.fn(() => true),
      writerState,
    }),
  }
}

async function dispatch(
  run: ReturnType<typeof createBufferedIngressMiddleware>,
  req = request(),
) {
  const res = new FakeResponse()
  const next = vi.fn()
  run(req, res, next)
  await vi.waitFor(() => {
    expect(next.mock.calls.length + Number(res.body !== null)).toBeGreaterThan(0)
  })
  return { req, res, next }
}

describe('buffered ingress admission', () => {
  test.each([
    ['0', 0],
    ['17', 17],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['', null],
    ['01', null],
    ['-1', null],
    ['9007199254740992', null],
  ])('strictly parses Content-Length %j', (raw, expected) => {
    expect(parseContentLength(raw)).toBe(expected)
  })

  test('keeps direct-stream routes outside the buffered budget', () => {
    expect(isStreamedIngress(request({
      path: '/api/plugin-storage/mutate',
      headers: {
        'content-type': 'application/octet-stream',
        'x-plugin-storage-stream': '1',
      },
    }))).toBe(true)
    expect(createRoutePolicyResolver(limits())(request({
      path: '/api/backup/import',
      headers: { 'content-type': 'application/octet-stream' },
    }))).toBeNull()
  })

  test('authenticates before inspecting or reserving an untrusted body', async () => {
    const authenticate = vi.fn(async (_req, res: FakeResponse) => {
      res.status(400).json({ error: 'No auth header' })
      return false
    })
    const admission = middleware({ authenticate })
    const result = await dispatch(admission.run, request({
      headers: { 'content-type': 'application/octet-stream' },
    }))

    expect(result.res.body).toEqual({ error: 'No auth header' })
    expect(admission.budget.snapshot().usedBytes).toBe(0)
    expect(result.next).not.toHaveBeenCalled()
  })

  test('rejects a stale writer without transitioning the writer lock', async () => {
    const writerState = vi.fn(() => 'stale')
    const admission = middleware({ writerState })
    const result = await dispatch(admission.run)

    expect(result.res.statusCode).toBe(423)
    expect(result.res.body).toEqual({ error: 'Session deactivated' })
    expect(writerState).toHaveBeenCalledOnce()
    expect(admission.budget.snapshot().usedBytes).toBe(0)
  })

  test('requires a declared identity-encoded body before parsing', async () => {
    const admission = middleware()
    const missing = await dispatch(admission.run, request({
      headers: { 'content-type': 'application/octet-stream' },
    }))
    expect(missing.res.statusCode).toBe(411)
    expect(missing.res.body).toMatchObject({
      code: 'BUFFERED_INGRESS_LENGTH_REQUIRED',
      commitOutcome: 'not-committed',
    })

    const compressed = await dispatch(admission.run, request({
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '8',
        'content-encoding': 'gzip',
      },
    }))
    expect(compressed.res.statusCode).toBe(415)
    expect(compressed.res.body).toMatchObject({
      code: 'BUFFERED_INGRESS_CONTENT_ENCODING_UNSUPPORTED',
    })
    expect(admission.budget.snapshot().usedBytes).toBe(0)
  })

  test('enforces route limits before reserving bytes', async () => {
    const budget = createInFlightByteBudget(256)
    const admission = middleware({ budget })
    const result = await dispatch(admission.run, request({
      path: '/api/plugin-storage/batch',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '65',
      },
    }))

    expect(result.res.statusCode).toBe(413)
    expect(result.res.body).toMatchObject({
      outcome: 'not-committed',
      operation: 'batch',
      code: 'PLUGIN_STORAGE_BATCH_TOO_LARGE',
      limit: 64,
      actual: 65,
    })
    expect(budget.snapshot().usedBytes).toBe(0)
  })

  test('bounds concurrent reservations and releases exactly once on finish or close', async () => {
    const budget = createInFlightByteBudget(12)
    const admission = middleware({ budget })
    const first = await dispatch(admission.run, request())
    expect(first.req[BUFFERED_INGRESS_POLICY]).toMatchObject({ maxBytes: 12 })
    expect(budget.snapshot().usedBytes).toBe(8)

    const busy = await dispatch(admission.run, request({
      headers: {
        ...request().headers,
        'content-length': '5',
      },
    }))
    expect(busy.res.statusCode).toBe(503)
    expect(busy.res.headers.get('retry-after')).toBe('1')
    expect(busy.res.body).toMatchObject({
      code: 'BUFFERED_INGRESS_BUSY',
      retryable: true,
      commitOutcome: 'not-committed',
    })
    expect(budget.snapshot().usedBytes).toBe(8)

    first.res.emit('finish')
    first.res.emit('close')
    expect(budget.snapshot().usedBytes).toBe(0)

    const admitted = await dispatch(admission.run, request({
      headers: {
        ...request().headers,
        'content-length': '12',
      },
    }))
    expect(admitted.next).toHaveBeenCalledOnce()
    admitted.res.emit('close')
    expect(budget.snapshot().usedBytes).toBe(0)
  })
})
