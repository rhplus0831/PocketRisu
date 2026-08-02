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
  expectedClientBuild = null as { version: string; stamp: string } | null,
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
      expectedClientBuild,
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

  test('keeps direct-stream routes admission-only and outside the buffered budget', () => {
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
    }))).toMatchObject({
      admissionOnly: true,
      writer: true,
      maxBytes: 0,
    })
  })

  test.each([
    ['matching served build', {
      version: '1.9.0',
      stamp: `1.9.0-${'e'.repeat(64)}`,
    }],
    ['no served build stamp', null],
  ])('retires the legacy transition before body admission with %s', async (
    _case,
    expectedClientBuild,
  ) => {
    const admission = middleware({ expectedClientBuild })
    const result = await dispatch(admission.run, request({
      path: '/api/plugin-storage/transition',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '999999999',
        ...(expectedClientBuild
          ? { 'x-client-build': expectedClientBuild.stamp }
          : {}),
      },
    }))

    expect(result.res.statusCode).toBe(426)
    expect(result.res.body).toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
      retryable: false,
    })
    if (expectedClientBuild) {
      expect(result.res.body).toMatchObject({ expectedBuild: expectedClientBuild })
    } else {
      expect(result.res.body).not.toHaveProperty('expectedBuild')
    }
    expect(result.res.headers.get('connection')).toBe('close')
    expect(result.next).not.toHaveBeenCalled()
    expect(admission.writerState).not.toHaveBeenCalled()
    expect(admission.budget.snapshot().usedBytes).toBe(0)
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

  test.each([
    ['missing', undefined],
    ['mismatched', '1.9.0-old-build'],
  ])('rejects a %s client stamp before reserving body bytes', async (_case, clientBuild) => {
    const expectedClientBuild = {
      version: '1.9.0',
      stamp: `1.9.0-${'a'.repeat(64)}`,
    }
    const admission = middleware({ expectedClientBuild })
    const headers = {
      ...request().headers,
      ...(clientBuild === undefined ? {} : { 'x-client-build': clientBuild }),
    }
    const result = await dispatch(admission.run, request({ headers }))

    expect(result.res.statusCode).toBe(426)
    expect(result.res.body).toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
      expectedBuild: expectedClientBuild,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(result.res.headers.get('connection')).toBe('close')
    expect(result.next).not.toHaveBeenCalled()
    expect(admission.writerState).not.toHaveBeenCalled()
    expect(admission.budget.snapshot().usedBytes).toBe(0)
  })

  test('admits a matching client stamp and fails open when no server stamp exists', async () => {
    const expectedClientBuild = {
      version: '1.9.0',
      stamp: `1.9.0-${'b'.repeat(64)}`,
    }
    const matching = middleware({ expectedClientBuild })
    const matched = await dispatch(matching.run, request({
      headers: {
        ...request().headers,
        'x-client-build': expectedClientBuild.stamp,
      },
    }))
    expect(matched.next).toHaveBeenCalledOnce()
    expect(matching.budget.snapshot().usedBytes).toBe(8)
    matched.res.emit('finish')

    const disabled = middleware({ expectedClientBuild: null })
    const failOpen = await dispatch(disabled.run)
    expect(failOpen.next).toHaveBeenCalledOnce()
    expect(disabled.budget.snapshot().usedBytes).toBe(8)
    failOpen.res.emit('finish')
  })

  test('leaves reads open and admits direct plugin streams without byte charging', async () => {
    const expectedClientBuild = {
      version: '1.9.0',
      stamp: `1.9.0-${'c'.repeat(64)}`,
    }
    const readAdmission = middleware({ expectedClientBuild })
    const read = await dispatch(readAdmission.run, request({
      path: '/api/db/read-cached',
      headers: {
        'content-type': 'application/json',
        'content-length': '2',
      },
    }))
    expect(read.next).toHaveBeenCalledOnce()
    expect(readAdmission.budget.snapshot().usedBytes).toBe(2)
    read.res.emit('finish')

    const streamAdmission = middleware({ expectedClientBuild })
    const streamed = await dispatch(streamAdmission.run, request({
      path: '/api/plugin-storage/transition/stage/upload',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '999999999',
        'x-client-build': expectedClientBuild.stamp,
      },
    }))
    expect(streamed.next).toHaveBeenCalledOnce()
    expect(streamAdmission.budget.snapshot().usedBytes).toBe(0)
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
