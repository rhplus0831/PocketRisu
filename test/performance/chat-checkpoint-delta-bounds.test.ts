import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'

const cache = vi.hoisted(() => ({
  enabled: process.env.POCKETRISU_PERF_RESOURCE_CACHE === 'on',
}))

vi.mock('svelte-sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('../../src/ts/process/modules', () => ({
  moduleUpdate: vi.fn(),
  getModules: () => [],
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleTriggers: () => [],
  getModuleRegexScripts: () => [],
  getModuleToggles: () => [],
  getModuleMcps: () => [],
  exportModuleLegacy: vi.fn(),
  readModule: vi.fn(),
}))

vi.mock('../../src/ts/storage/payloadCodecClient', () => ({
  encodeChatRowPayload: async (chat: unknown, hash: boolean) => {
    const bytes = new TextEncoder().encode(JSON.stringify(chat))
    return {
      bytes,
      hash: hash ? createHash('sha256').update(bytes).digest('hex') : null,
    }
  },
  prepareChatRowCheckpoint: async (previousChat: unknown | null, chat: unknown) => {
    const { prepareChatDeltaPatch } = await import('../../src/ts/storage/chatDelta')
    const snapshot = structuredClone(chat)
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
    return {
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex'),
      patch: previousChat === null ? null : prepareChatDeltaPatch(previousChat, snapshot),
      snapshot,
    }
  },
}))

vi.mock('../../src/ts/storage/resourceCache', () => ({
  RESOURCE_CACHE_MAX_ENTRIES: 32_768,
  RESOURCE_CACHE_MAX_STORED_BYTES: 64 * 1024 * 1024,
  RESOURCE_CACHE_MAX_VALUE_BYTES: 32 * 1024 * 1024,
  applyOwnedResourceCacheMutations: vi.fn(async () => undefined),
  getManifestHashes: vi.fn(async () => []),
  getVerifiedManifestSnapshot: vi.fn(async () => null),
  getVerifiedCachedBytes: vi.fn(async () => null),
  invalidateResourceCacheManifest: vi.fn(async () => undefined),
  invalidateResourceCachePrefix: vi.fn(async () => undefined),
  isResourceCacheEnabled: () => cache.enabled,
  isSha256Hex: (value: unknown) => (
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  ),
  persistResourceCacheManifests: vi.fn(async () => undefined),
  sha256Bytes: vi.fn(async (bytes: Uint8Array) => (
    createHash('sha256').update(bytes).digest('hex')
  )),
  sha256OwnedBytes: vi.fn(async (bytes: Uint8Array) => (
    createHash('sha256').update(bytes).digest('hex')
  )),
  settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
    try { return await operation } catch { return fallback }
  },
  storeBytes: vi.fn(async () => undefined),
  storeOwnedBytesWithKnownHash: vi.fn(async () => undefined),
  touchResourceCacheManifest: vi.fn(async () => undefined),
}))

vi.mock('../../src/ts/alert', () => ({
  alertInput: vi.fn(),
  notifyError: vi.fn(),
  waitAlert: vi.fn(),
}))

vi.mock('src/lang', () => ({ language: {} }))

vi.mock('../../src/ts/storage/database.svelte', () => ({
  normalizeChat: (chat: unknown) => chat,
}))

const { applyPatch } = await import('fast-json-patch')
const { NodeStorage } = await import('../../src/ts/storage/nodeStorage')

type CheckpointMetrics = {
  uploadBytes: number
  processedBytes: number
  logicalRowBytes: number
  deltaBytes: number
}

function makeChat(messageCount: number) {
  return {
    id: 'checkpoint-chat',
    name: 'Streaming checkpoint',
    message: Array.from({ length: messageCount }, (_, index) => ({
      chatId: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'char',
      data: `${index}:${'x'.repeat(16 * 1024)}`,
    })),
    note: '',
    localLore: [],
  }
}

async function requestBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  throw new TypeError(`Unsupported checkpoint request body: ${String(body)}`)
}

async function checkpointWork(messageCount: number): Promise<CheckpointMetrics> {
  const storage = new NodeStorage()
  storage.authChecked = true
  ;(NodeStorage as any).sessionInitialized = true
  vi.spyOn(storage, 'createAuth').mockResolvedValue('test-token')

  let serverChat: any = null
  let requestNumber = 0
  let checkpointUploadBytes = 0
  let checkpointProcessedBytes = 0

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestNumber++
    const bytes = await requestBytes(init?.body)
    const contentType = new Headers(init?.headers).get('content-type') ?? ''
    let responseHash: string

    if (contentType.includes('chat-delta')) {
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
        patch: any[]
        resultHash: string
        resultSize: number
      }
      serverChat = applyPatch(serverChat, payload.patch, true, false).newDocument
      const materialized = new TextEncoder().encode(JSON.stringify(serverChat))
      responseHash = createHash('sha256').update(materialized).digest('hex')
      expect(responseHash).toBe(payload.resultHash)
      expect(materialized.byteLength).toBe(payload.resultSize)
      if (requestNumber === 2) {
        checkpointUploadBytes = bytes.byteLength
        checkpointProcessedBytes = new TextEncoder().encode(
          JSON.stringify(payload.patch),
        ).byteLength
      }
    } else {
      serverChat = JSON.parse(new TextDecoder().decode(bytes))
      responseHash = createHash('sha256').update(bytes).digest('hex')
      if (requestNumber === 2) {
        checkpointUploadBytes = bytes.byteLength
        checkpointProcessedBytes = bytes.byteLength
      }
    }

    return new Response(JSON.stringify({ success: true, hash: responseHash }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))

  const chat = makeChat(messageCount)
  await storage.saveChatContent('checkpoint-character', 0, chat.id, chat)
  const delta = '-stream-fragment-'.repeat(16)
  chat.message[chat.message.length - 1].data += delta
  const logicalRowBytes = new TextEncoder().encode(JSON.stringify(chat)).byteLength
  await storage.saveChatContent('checkpoint-character', 0, chat.id, chat)

  vi.unstubAllGlobals()
  return {
    uploadBytes: checkpointUploadBytes,
    processedBytes: checkpointProcessedBytes,
    logicalRowBytes,
    deltaBytes: new TextEncoder().encode(delta).byteLength,
  }
}

describe('streaming chat checkpoint delta bounds', () => {
  test('checkpoint upload and server operation work scale with the delta, not the chat', async () => {
    const small = await checkpointWork(16)
    const large = await checkpointWork(512)

    console.info('[Track 6 chat checkpoint]', JSON.stringify({
      cache: cache.enabled ? 'on' : 'off',
      small,
      large,
    }))

    expect(large.logicalRowBytes).toBeGreaterThan(small.logicalRowBytes * 20)
    expect(large.uploadBytes).toBeLessThanOrEqual(small.uploadBytes * 2)
    expect(large.processedBytes).toBeLessThanOrEqual(small.processedBytes * 2)
    expect(large.uploadBytes).toBeLessThan(large.logicalRowBytes / 8)
    expect(large.processedBytes).toBeLessThan(large.logicalRowBytes / 8)
  })
})
